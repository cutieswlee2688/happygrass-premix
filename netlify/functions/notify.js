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

  // One message per manufacturing day, each with that day's own totals.
  const byDate = {};
  rows.forEach((r) => {
    const d = r.date || p.date || "undated";
    (byDate[d] = byDate[d] || []).push(r);
  });
  const days = Object.keys(byDate).sort();
  const sum = (list, f) => list.reduce((a, r) => a + (parseFloat(r[f]) || 0), 0);
  const nice = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(8, 10) + "/" + d.slice(5, 7) + "/" + d.slice(0, 4) : d;

  const messages = days.map((d, i) => {
    const g = byDate[d];
    const c = sum(g, "ctn"), pk = sum(g, "pac");
    const shifts = [...new Set(g.map((r) => r.shift || p.shift).filter(Boolean))].join(", ");
    const heading = (p.kind === "summary" ? "DAILY PRODUCTION REPORT" : "Production recorded") +
      ` — ${nice(d)}` + (shifts ? ` / ${shifts}` : "") + (days.length > 1 ? `  (${i + 1} of ${days.length})` : "");
    const lines = g.map(oneLine).join("\n");
    const total = `${c} ctn` + (pk ? `, ${pk} pac` : "");
    return { date: nice(d), shift: shifts, lines, total,
      text: `${heading}\n\n${lines}\n\nDAY TOTAL: ${c} cartons` + (pk ? `, ${pk} loose packs` : "") + `\n${g.length} lines` };
  });

  const prefix = channel === "whatsapp" ? "whatsapp:" : "";
  const sender = from.startsWith("whatsapp:") || channel !== "whatsapp" ? from : prefix + from;
  const recipients = to.split(",").map((n) => n.trim()).filter(Boolean);

  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");

  const results = [];
  for (const m of messages) {
    for (const n of recipients) {
      const form = new URLSearchParams();
      form.set("From", sender);
      form.set("To", prefix + n.replace(/^whatsapp:/, ""));
      if (channel === "whatsapp" && contentSid) {
        form.set("ContentSid", contentSid);
        form.set("ContentVariables", JSON.stringify({
          1: m.date,
          2: m.shift || p.shift || "",
          3: m.lines.length > 900 ? m.lines.slice(0, 880) + "\n…(more in Google Sheet)" : m.lines,
          4: m.total,
        }));
      } else {
        form.set("Body", m.text);
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
          results.push({ to: n, day: m.date, ok: false, error: d.message, code: d.code });
        } else {
          results.push({ to: n, day: m.date, ok: true, sid: d.sid, status: d.status });
        }
      } catch (err) {
        console.error(err);
        results.push({ to: n, day: m.date, ok: false, error: "Could not reach Twilio" });
      }
    }
  }

  const failed = results.filter((x) => !x.ok);
  if (failed.length === results.length) {
    return json(502, { error: failed[0].error || "Message not accepted", results });
  }
  return json(200, { ok: true, days: messages.length, results });
};
