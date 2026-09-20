// Reads a photographed production sheet.
// The Anthropic API key stays here on the server and never reaches the phone.

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

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json(500, { error: "ANTHROPIC_API_KEY is not set on this site" });

  let b64, media, prompt;
  try { ({ b64, media, prompt } = JSON.parse(event.body || "{}")); }
  catch { return json(400, { error: "Bad request body" }); }
  if (!b64 || !prompt) return json(400, { error: "Missing photo or prompt" });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: media || "image/jpeg", data: b64 } },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      console.error("Anthropic error", data);
      return json(502, { error: (data.error && data.error.message) || "Could not read the photo" });
    }
    return json(200, data);
  } catch (err) {
    console.error(err);
    return json(502, { error: "Could not reach the reading service" });
  }
};
