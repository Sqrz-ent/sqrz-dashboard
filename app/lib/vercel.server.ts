const VERCEL_API = "https://api.vercel.com";
const PROJECT_ID = process.env.VERCEL_PROJECT_ID;
const TEAM = process.env.VERCEL_TEAM_ID
  ? `?teamId=${process.env.VERCEL_TEAM_ID}`
  : "";
const HEADERS = {
  Authorization: `Bearer ${process.env.VERCEL_API_TOKEN}`,
  "Content-Type": "application/json",
};

export async function addDomainToVercel(domain: string) {
  const res = await fetch(
    `${VERCEL_API}/v10/projects/${PROJECT_ID}/domains${TEAM}`,
    { method: "POST", headers: HEADERS, body: JSON.stringify({ name: domain }) }
  );
  return res.json();
}

export async function getDomainStatus(domain: string) {
  const res = await fetch(
    `${VERCEL_API}/v10/projects/${PROJECT_ID}/domains/${domain}${TEAM}`,
    { headers: HEADERS }
  );
  return res.json();
}

export async function removeDomainFromVercel(domain: string) {
  await fetch(
    `${VERCEL_API}/v10/projects/${PROJECT_ID}/domains/${domain}${TEAM}`,
    { method: "DELETE", headers: HEADERS }
  );
}
