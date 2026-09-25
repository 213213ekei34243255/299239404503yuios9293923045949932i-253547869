const URL = "https://www.noahai.live/predict";
async function chat(message, page) {
  const t0 = Date.now();
  const res = await fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "chat", session_id: "probe-" + Date.now() + Math.random(), message, page_content: page }), signal: AbortSignal.timeout(90000) });
  const txt = await res.text();
  let j = null;
  try { j = JSON.parse(txt); } catch (_) { /* not json */ }
  return { ms: Date.now() - t0, answer: j && typeof j.answer === "string" ? j.answer : "", raw: txt.slice(0, 200) };
}
const TASK = "a program of palindrome accepting 30 different input numbers including fibonacci tribonacci";
const PAGE = "An online Python code editor with an empty file called main.py.";
const PLAIN = "Reply with only the code: no explanation, no markdown fences, no text before or after it.";
const VARIANTS = {
  C1: [`Write a complete Python program: ${TASK}. ${PLAIN}`, PAGE],
  C2: [`Write Python code for this: ${TASK}. ${PLAIN}`, PAGE],
  C3: [`Write a Python program that checks palindromes for 30 numbers read from input, and also prints fibonacci and tribonacci numbers. ${PLAIN}`, PAGE],
};
(async () => {
  for (const [name, [msg, page]] of Object.entries(VARIANTS)) {
    for (let i = 0; i < 2; i++) {
      const r = await chat(msg, page).catch((e) => ({ answer: "", raw: "ERR " + (e.cause && e.cause.code || e.message), ms: 0 }));
      const lines = r.answer.split("\n").length;
      console.log(`${name}#${i} ${r.ms}ms lines=${lines} chars=${r.answer.length} fenced=${/```/.test(r.answer)} raw=${r.answer ? "" : r.raw}`);
      if (i === 0) console.log(r.answer.slice(0, 700).replace(/^/gm, "    | "));
    }
  }
})();
