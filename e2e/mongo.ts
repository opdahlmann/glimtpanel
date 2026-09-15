// MongoDB for e2e når ingen er satt opp: `docker run --rm -d -p 127.0.0.1:0:27017 mongo:8` med tilfeldig port.
// Kalles fra playwright.config.ts ved innlasting (før webServer starter huben), fordi `webServer.env` er statisk og
// globalSetup kjører etter at serverne er startet. Huben seeder dev-brukeren bare hvis Mongo er oppe ved oppstart,
// så vi venter på `ping` før vi returnerer. Stoppes i global-teardown.ts.
import { execSync } from 'node:child_process';

export const MONGO_CONTAINER = 'glimt-e2e-mongo';
const MONGO_IMAGE = 'mongo:8';

function sh(cmd: string, timeoutMs = 30_000): string {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs }).toString().trim();
}

function dockerAvailable(): boolean {
  try {
    sh('docker version --format {{.Server.Version}}', 10_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * true når en hub allerede svarer (npm run dev): da trenger vi ingen egen Mongo. En hub som svarer men har mistet
 * databasen (typisk en gjenglemt Playwright-hub etter at mongo-containeren ble ryddet) stopper kjøringen med én
 * tydelig melding i stedet for 190 tester som feiler med 503.
 */
function hubAlreadyRunning(hubUrl: string): boolean {
  let body: string;
  try {
    body = sh(`curl -sf --max-time 2 ${hubUrl}/healthz`, 5_000);
  } catch {
    return false;
  }
  let health: { mongo?: string; env?: string } = {};
  try {
    health = JSON.parse(body) as { mongo?: string; env?: string };
  } catch {
    // ikke JSON: behandles som kjørende
  }
  if (health.mongo && health.mongo !== 'ok') {
    throw new Error(
      `e2e: en hub svarer allerede på ${hubUrl} (env ${health.env ?? '?'}) men uten MongoDB (mongo: ${health.mongo}). ` +
        'Det er som regel en gjenglemt hub fra en tidligere kjøring: stopp den med `npm run dev:stop` (eller `pkill -f Glimt.Hub/bin`) og kjør igjen.',
    );
  }
  return true;
}

/**
 * Returnerer GLIMT_MONGO_URI for huben: den som er satt i miljøet, ellers en ny container (når docker finnes og
 * ingen hub kjører), ellers null (huben starter uten database; innloggingstestene vil da feile med 503).
 * Kjøres én gang: Playwright laster config-filen også i arbeiderprosessene, men de arver miljøet fra hovedprosessen.
 */
export function ensureMongo(hubUrl: string): string | null {
  if (process.env.GLIMT_MONGO_URI) return process.env.GLIMT_MONGO_URI;
  if (hubAlreadyRunning(hubUrl) || !dockerAvailable()) return null;

  try {
    sh(`docker rm -f ${MONGO_CONTAINER}`, 20_000);
  } catch {
    // fantes ikke
  }
  sh(`docker run -d --rm --name ${MONGO_CONTAINER} -p 127.0.0.1:0:27017 ${MONGO_IMAGE}`, 120_000);
  const mapping = sh(`docker port ${MONGO_CONTAINER} 27017/tcp`);
  const port = mapping.split('\n')[0].split(':').pop();
  if (!port) throw new Error(`e2e: fant ikke porten til ${MONGO_CONTAINER}: ${mapping}`);

  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      if (sh(`docker exec ${MONGO_CONTAINER} mongosh --quiet --eval "db.runCommand({ping:1}).ok"`, 10_000) === '1') {
        ready = true;
        break;
      }
    } catch {
      // ikke klar ennå
    }
    execSync('sleep 0.5');
  }
  if (!ready) throw new Error('e2e: MongoDB-containeren svarte ikke på ping innen 60 s');

  const uri = `mongodb://127.0.0.1:${port}/?directConnection=true&serverSelectionTimeoutMS=2000`;
  process.env.GLIMT_MONGO_URI = uri;
  process.env.GLIMT_E2E_MONGO_STARTED = MONGO_CONTAINER;
  console.log(`e2e: startet ${MONGO_CONTAINER} (${MONGO_IMAGE}) på port ${port}`);
  return uri;
}

export function stopMongo(): void {
  const name = process.env.GLIMT_E2E_MONGO_STARTED;
  if (!name) return;
  try {
    sh(`docker rm -f ${name}`, 30_000);
    console.log(`e2e: stoppet ${name}`);
  } catch {
    // allerede borte
  }
  delete process.env.GLIMT_E2E_MONGO_STARTED;
}
