// Stopper MongoDB-containeren som playwright.config.ts startet (se mongo.ts). Kjører etter alle testene.
import { stopMongo } from './mongo';

export default function globalTeardown(): void {
  stopMongo();
}
