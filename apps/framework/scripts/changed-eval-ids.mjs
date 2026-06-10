#!/usr/bin/env node

const input = await new Promise((resolve, reject) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    data += chunk;
  });
  process.stdin.on("end", () => resolve(data));
  process.stdin.on("error", reject);
});

const evalIds = new Set();

for (const changedPath of input.split(/\r?\n/)) {
  const [topLevelDir, evalId, ...rest] = changedPath.split("/");

  if (topLevelDir === "evals" && evalId && rest.length > 0) {
    evalIds.add(evalId);
  }
}

process.stdout.write(`${JSON.stringify([...evalIds].sort())}\n`);
