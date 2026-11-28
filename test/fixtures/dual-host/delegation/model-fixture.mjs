// Deterministic OpenAI-compatible model fixture for the U2 delegation check.
// It is the ONLY "model" any host in that check can reach: a loopback HTTP
// server in the harness process, no provider, no credential, no network.
//
// Two roles share one listener, split by URL prefix:
//   /controller/v1   scripted tool caller. The user prompt carries a plan,
//                    `@@PLAN=<json array>`, of { tool, args } steps. Each
//                    model turn emits exactly the next step as a tool call
//                    (v2.3.2 hides plugin tools behind its Code Mode
//                    `execute` tool, so a step is sent as
//                    `return await tools.<tool>(<args>)` through `execute`);
//                    `{{sessionId}}` in an argument is replaced with the
//                    session id parsed from an earlier bus_task result. Once
//                    every step has a tool result the model answers with
//                    `PLAN-COMPLETE steps=<n>`. The decision is a pure
//                    function of the conversation, so retries and
//                    title/summary requests cannot desynchronize it.
//   /target/<label>/v1  echo (the label names which target host called).
//                    Replies `ACK <nonce>` for the `U2N-...` nonce found
//                    in the last user message, and never calls a tool.
//
// Every request is recorded (role, nonces, working directory the host put in
// its system prompt, step taken) so the harness can prove which host saw what.

import { createServer } from "node:http";

const NONCE = /U2N-[A-Za-z0-9]+/g;
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const planTools = new Set(["bus_task", "bus_wait", "bus_result"]);

function badRequest(res) {
  res.writeHead(400, { "content-type": "application/json" });
  res.end(
    JSON.stringify({ error: { message: "u2 fixture: invalid request" } }),
  );
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("\n");
  }
  return "";
}

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user")
      return { index: i, text: textOf(messages[i].content) };
  }
  return { index: -1, text: "" };
}

function workingDirectory(messages) {
  const system = messages
    .filter((m) => m?.role === "system" || m?.role === "developer")
    .map((m) => textOf(m.content))
    .join("\n");
  const found =
    /Working directory:\s*(\S+)/i.exec(system) ??
    /<cwd>\s*([^<\s]+)\s*<\/cwd>/i.exec(system) ??
    /current working directory[^\n]*?:\s*(\S+)/i.exec(system);
  return found?.[1] ?? null;
}

function controllerDecision(messages) {
  const user = messages
    .map((m, i) => ({ m, i }))
    .filter(
      ({ m, i }) => m?.role === "user" && textOf(m.content).includes("@@PLAN="),
    );
  const marker = user.at(-1);
  if (!marker) return { kind: "text", text: "NO-PLAN" };
  const raw = textOf(marker.m.content);
  let plan;
  try {
    plan = JSON.parse(
      raw.slice(raw.indexOf("@@PLAN=") + "@@PLAN=".length).split("\n")[0],
    );
  } catch {
    return null;
  }
  if (
    !Array.isArray(plan) ||
    !plan.every(
      (step) =>
        isRecord(step) &&
        planTools.has(step.tool) &&
        (step.args === undefined || isRecord(step.args)),
    )
  )
    return null;
  const after = messages.slice(marker.i + 1);
  const results = after
    .filter((m) => m?.role === "tool")
    .map((m) => textOf(m.content));
  const step = results.length;
  if (step >= plan.length)
    return { kind: "text", text: `PLAN-COMPLETE steps=${plan.length}`, step };
  // Session ids in dispatch order: {{sessionId}} is the first, {{sessionId2}}
  // the second. A dispatch result reads `Session ses_... in <project>`.
  const sids = results.flatMap((r) =>
    [...r.matchAll(/Session (ses_[A-Za-z0-9]+) in /g)].map((m) => m[1]),
  );
  const fill = (v) =>
    typeof v === "string"
      ? v
          .replaceAll("{{sessionId}}", sids[0] ?? "MISSING-SESSION-ID")
          .replaceAll("{{sessionId2}}", sids[1] ?? "MISSING-SESSION-ID")
      : Array.isArray(v)
        ? v.map(fill)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]))
          : v;
  const next = plan[step];
  const args = fill(next.args ?? {});
  return {
    kind: "tool",
    name: "execute",
    args: { code: `return await tools.${next.tool}(${JSON.stringify(args)});` },
    step,
    planned: { tool: next.tool, args },
  };
}

function sse(res, chunks) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function chunk(id, model, delta, finish, usage) {
  return {
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  };
}

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

function reply(res, body, decision) {
  const model = body.model ?? "scripted";
  const id = `chatcmpl-u2-${Math.random().toString(16).slice(2, 10)}`;
  const stream = body.stream !== false;
  if (decision.kind === "tool") {
    const call = {
      index: 0,
      id: `call_u2_${decision.step}`,
      type: "function",
      function: {
        name: decision.name,
        arguments: JSON.stringify(decision.args),
      },
    };
    if (!stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id,
          object: "chat.completion",
          created: 0,
          model,
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{ ...call, index: undefined }],
              },
            },
          ],
          usage: USAGE,
        }),
      );
      return;
    }
    sse(res, [
      chunk(
        id,
        model,
        { role: "assistant", content: null, tool_calls: [call] },
        null,
      ),
      chunk(id, model, {}, "tool_calls", USAGE),
    ]);
    return;
  }
  if (!stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id,
        object: "chat.completion",
        created: 0,
        model,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: decision.text },
          },
        ],
        usage: USAGE,
      }),
    );
    return;
  }
  sse(res, [
    chunk(id, model, { role: "assistant", content: "" }, null),
    chunk(id, model, { content: decision.text }, null),
    chunk(id, model, {}, "stop", USAGE),
  ]);
}

/** Starts the fixture on 127.0.0.1:<port> (0 = ephemeral). */
export function startModelFixture(port = 0) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const targetLabel = /^\/target\/([A-Za-z0-9-]+)\//.exec(
        url.pathname,
      )?.[1];
      const role = url.pathname.startsWith("/controller/")
        ? "controller"
        : targetLabel
          ? "target"
          : null;
      if (
        role === null ||
        req.method !== "POST" ||
        !url.pathname.endsWith("/chat/completions")
      ) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: { message: "u2 fixture: unknown route" } }),
        );
        requests.push({
          role: "unknown",
          method: req.method,
          path: url.pathname,
        });
        return;
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "u2 fixture: bad json" } }));
        return;
      }
      if (!isRecord(body) || !Array.isArray(body.messages))
        return badRequest(res);
      const messages = body.messages;
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const user = lastUser(messages);
      let decision;
      if (role === "controller") {
        try {
          decision = hasTools
            ? controllerDecision(messages)
            : { kind: "text", text: "U2 fixture title" };
        } catch {
          return badRequest(res);
        }
        if (!decision) return badRequest(res);
      } else {
        const nonce = user.text.match(NONCE)?.at(-1);
        decision = { kind: "text", text: nonce ? `ACK ${nonce}` : "ACK" };
      }
      requests.push({
        role,
        label: targetLabel ?? null,
        hasTools,
        toolNames: hasTools
          ? body.tools.map((t) => t?.function?.name).filter(Boolean)
          : [],
        nonces: [
          ...new Set(
            messages
              .map((m) => textOf(m?.content))
              .join("\n")
              .match(NONCE) ?? [],
          ),
        ],
        cwd: workingDirectory(messages),
        decision:
          decision.kind === "tool"
            ? { ...decision.planned, via: decision.name, step: decision.step }
            : { text: decision.text },
      });
      reply(res, body, decision);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: address.port,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
