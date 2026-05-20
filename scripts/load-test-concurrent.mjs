// Anonymous concurrent-user smoke test for the async job queue.
// Boots N parallel POST /api/generate, then polls all returned jobIds and
// prints a per-second status snapshot until every job has finished.
//
// Run against a server started with MOUSIKE_DEV=1 (skips rate limit + quota
// + queue caps so the test isn't shaped by admission).
//
//   node scripts/load-test-concurrent.mjs           # default N=5
//   node scripts/load-test-concurrent.mjs 8         # N=8
//
// Exits 0 once all jobs reach done|failed, or after MAX_WAIT_MS.

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8787";
const N = Number(process.argv[2] ?? "5");
const POLL_INTERVAL_MS = 2_000;
const SNAPSHOT_INTERVAL_MS = 3_000;
const MAX_WAIT_MS = 15 * 60_000;

const PROMPT_POOL = [
  "K팝 댄스 트랙",
  "재즈 피아노 발라드",
  "락 일렉 기타 솔로",
  "힙합 808 비트",
  "신스 일렉트로닉",
  "R&B 슬로우 잼",
  "어쿠스틱 기타 발라드",
  "트로트 신곡",
];

const t0 = Date.now();
function ts() {
  const ms = Date.now() - t0;
  return `[+${(ms / 1000).toFixed(1)}s]`.padEnd(10);
}

async function enqueueOne(prompt) {
  const res = await fetch(`${BACKEND}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, lang: "KO" }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function pollOne(jobId) {
  const res = await fetch(`${BACKEND}/api/jobs/${jobId}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { status: "poll_error", httpStatus: res.status, error: body.error };
  }
  return res.json();
}

async function main() {
  console.log(`${ts()} starting load test: N=${N} concurrent users against ${BACKEND}`);

  const enqueueStart = Date.now();
  const enqueueResults = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      enqueueOne(PROMPT_POOL[i % PROMPT_POOL.length]).then((r) => ({ idx: i, ...r })),
    ),
  );
  const enqueueMs = Date.now() - enqueueStart;
  console.log(`${ts()} ${N} enqueue requests sent in ${enqueueMs}ms`);

  const jobs = [];
  for (const r of enqueueResults) {
    if (r.ok && r.body.jobId) {
      jobs.push({ idx: r.idx, jobId: r.body.jobId, lastStatus: "queued", queuePos: null, done: false });
      console.log(`${ts()}   user#${r.idx}: enqueued jobId=${r.body.jobId.slice(0, 12)}`);
    } else {
      console.log(`${ts()}   user#${r.idx}: REJECTED ${r.status} ${JSON.stringify(r.body)}`);
    }
  }

  if (jobs.length === 0) {
    console.error(`${ts()} no jobs enqueued, aborting`);
    process.exit(1);
  }

  let lastSnapshot = 0;
  const deadline = Date.now() + MAX_WAIT_MS;
  while (jobs.some((j) => !j.done)) {
    if (Date.now() > deadline) {
      console.error(`${ts()} timeout after ${MAX_WAIT_MS / 1000}s`);
      break;
    }
    const views = await Promise.all(
      jobs.filter((j) => !j.done).map(async (j) => {
        const v = await pollOne(j.jobId);
        if (v.status === "poll_error") {
          console.log(`${ts()}   user#${j.idx}: poll error ${v.httpStatus} ${v.error}`);
          return null;
        }
        const prev = j.lastStatus;
        j.lastStatus = v.status;
        j.queuePos = v.queuePosition ?? null;
        if (prev !== v.status) {
          const detail = v.status === "queued" ? ` (pos=${v.queuePosition})` :
                         v.status === "failed" ? ` (${v.error})` : "";
          console.log(`${ts()}   user#${j.idx} ${prev} → ${v.status}${detail}`);
        }
        if (v.status === "done" || v.status === "failed") j.done = true;
        return v;
      }),
    );
    void views;

    const now = Date.now();
    if (now - lastSnapshot >= SNAPSHOT_INTERVAL_MS) {
      const counts = { queued: 0, running: 0, done: 0, failed: 0 };
      for (const j of jobs) counts[j.lastStatus] = (counts[j.lastStatus] ?? 0) + 1;
      console.log(
        `${ts()} snapshot — queued=${counts.queued} running=${counts.running} done=${counts.done} failed=${counts.failed}`,
      );
      lastSnapshot = now;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  console.log(`${ts()} all jobs finished`);
  const ok = jobs.filter((j) => j.lastStatus === "done").length;
  const failed = jobs.filter((j) => j.lastStatus === "failed").length;
  console.log(`${ts()} summary: ${ok} done, ${failed} failed, ${N - jobs.length} rejected at enqueue`);
}

main().catch((err) => {
  console.error("load test failed:", err);
  process.exit(1);
});
