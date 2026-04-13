// Netlify serverless function — client login
//
// Reads client credentials from a published Google Sheet (server-side only).
// The sheet URL is stored in a Netlify environment variable called CLIENTS_SHEET_URL.
// Sheet columns: Name, Password, URL
//
// To add/remove/change clients: just edit the Google Sheet.
// Changes propagate within ~5 minutes (Google's CDN cache).

const https = require("https");
const http = require("http");

function fetchSheet(url, maxRedirects) {
  if (maxRedirects === undefined) maxRedirects = 5;
  return new Promise((resolve, reject) => {
    const sep = url.includes("?") ? "&" : "?";
    const fullUrl = url + sep + "t=" + Date.now();
    const client = fullUrl.startsWith("https") ? https : http;
    client
      .get(fullUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (maxRedirects <= 0) return reject(new Error("Too many redirects"));
          return fetchSheet(res.headers.location, maxRedirects - 1).then(resolve, reject);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error("HTTP " + res.statusCode));
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(cell);
        cell = "";
      } else if (c === "\n" || c === "\r") {
        if (cell !== "" || row.length) {
          row.push(cell);
          rows.push(row);
          row = [];
          cell = "";
        }
        if (c === "\r" && text[i + 1] === "\n") i++;
      } else {
        cell += c;
      }
    }
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let org, password;
  try {
    const body = JSON.parse(event.body);
    org = (body.org || "").trim();
    password = (body.password || "").trim();
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request" }) };
  }

  if (!org || !password) {
    return { statusCode: 401, body: JSON.stringify({ error: "Missing credentials" }) };
  }

  const sheetUrl = process.env.CLIENTS_SHEET_URL;
  if (!sheetUrl) {
    return { statusCode: 500, body: JSON.stringify({ error: "Server configuration error" }) };
  }

  try {
    const csv = await fetchSheet(sheetUrl);
    const rows = parseCSV(csv);
    const clients = rows
      .map((r) => ({
        org: (r[0] || "").trim(),
        code: (r[1] || "").trim(),
        url: (r[2] || "").trim(),
      }))
      .filter((r) => r.org && r.code && /^https?:\/\//i.test(r.url));

    const match = clients.find((c) => c.org === org && c.code === password);

    if (!match) {
      return { statusCode: 401, body: JSON.stringify({ error: "Invalid credentials" }) };
    }

    return { statusCode: 200, body: JSON.stringify({ url: match.url }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: "Login service unavailable" }) };
  }
};
