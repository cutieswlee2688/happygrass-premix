// Sends the production update to the boss over WhatsApp (or SMS) via Twilio.
// Twilio credentials and the boss's number stay here on the server.

exports.handler = async (event) => {
  const json = (code, obj) => ({
    statusCode: code,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  });

  if (event.httpMethod !== "POST") return json(405, { error: "Use POST" });

  const passcode = process.env.APP_PASSCODE;
  if (!passcode) return json(500, { error: "APP_PASSCODE is not set on this site" });
  const given = event.headers["x-app-passcode"] || event.headers["X-App-Passcode"];
  if (given !== passcode) return json(401, { error: "Wrong passcode" });

  let p;
  try { p = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "Bad request body" }); }

  if (p.check) return json(200, { ok: true });

  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_FROM;
  const to    = process.env.BOSS_NUMBERS;
  const contentSid = process.env.TWILIO_CONTENT_SID || "";
  const channel = (process.env.NOTIFY_CHANNEL || "whatsapp").toLowerCase();

  const missing = [];
  if (!sid)   missing.push("TWILIO_ACCOUNT_SID");
  if (!token) missing.push("TWILIO_AUTH_TOKEN");
  if (!from)  missing.push("TWILIO_FROM");
  if (!to)    missing.push("BOSS_NUMBERS");
  if (missing.length) {
    return json(500, { error: "Missing on this site: " + missing.join(", ") +
      ". Add them in Netlify, then redeploy." });
  }

  const rows = p.rows || [];
  if (!rows.length) return json(400, { error: "Nothing to report" });

  const oneLine = (r) => {
    const qty = [
      r.ctn ? `${r.ctn} ctn` : "",
      r.pac ? `${r.pac} pac` : "",
    ].filter(Boolean).join(" + ") || "0";
    const who = r.customer ? `  (${r.customer})` : "";
    return `• ${r.item || r.code}${who}\n  ${qty} — ${r.batch}`;
  };

  // Group by manufacturing date so several days never blur into one figure.
  const byDate = {};
  rows.forEach((r) => {
    const d = r.date || p.date || "undated";
    (byDate[d] = byDate[d] || []).push(r);
  });
  const days = Object.keys(byDate).sort();

  const sum = (list, f) => list.reduce((a, r) => a + (parseFloat(r[f]) || 0), 0);

  const lines = days.map((d) => {
    const g = byDate[d];
    const c = sum(g, "ctn"), pk = sum(g, "pac");
    const head = days.length > 1 ? `\n── ${d} ──\n` : "";
    const foot = days.length > 1
      ? `\n   ${d} subtotal: ${c} ctn` + (pk ? `, ${pk} pac` : "")
      : "";
    return head + g.map(oneLine).join("\n") + foot;
  }).join("\n");

  const totalCtn = sum(rows, "ctn");
  const totalPac = sum(rows, "pac");

  const span = days.length > 1 ? `${days[0]} to ${days[days.length - 1]}` : (days[0] || p.date);
  const heading = p.kind === "summary"
    ? `PRODUCTION SUMMARY — ${span}`
    : `Production recorded — ${span} / ${p.shift}`;

  const text = `${heading}\n\n${lines}\n\n` +
    `TOTAL: ${totalCtn} cartons` + (totalPac ? `, ${totalPac} loose packs` : "") +
    `\n${rows.length} lines` + (days.length > 1 ? ` across ${days.length} days` : "");

  const prefix = channel === "whatsapp" ? "whatsapp:" : "";
  const sender = from.startsWith("whatsapp:") || channel !== "whatsapp" ? from : prefix + from;
  const recipients = to.split(",").map((n) => n.trim()).filter(Boolean);

  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");

  const results = [];
  for (const n of recipients) {
    const form = new URLSearchParams();
    form.set("From", sender);
    form.set("To", prefix + n.replace(/^whatsapp:/, ""));

    if (channel === "whatsapp" && contentSid) {
      form.set("ContentSid", contentSid);
      form.set("ContentVariables", JSON.stringify({
        1: p.date,
        2: p.shift || "",
        3: lines.slice(0, 900),
        4: `${totalCtn} ctn` + (totalPac ? `, ${totalPac} pac` : ""),
      }));
    } else {
      form.set("Body", text);
    }

    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      const d = await r.json();
      if (!r.ok) {
        console.error("Twilio error", d);
        results.push({ to: n, ok: false, error: d.message, code: d.code });
      } else {
        results.push({ to: n, ok: true, sid: d.sid, status: d.status });
      }
    } catch (err) {
      console.error(err);
      results.push({ to: n, ok: false, error: "Could not reach Twilio" });
    }
  }

  const failed = results.filter((x) => !x.ok);
  if (failed.length === results.length) {
    return json(502, { error: failed[0].error || "Message not accepted", results });
  }
  return json(200, { ok: true, results });
};
