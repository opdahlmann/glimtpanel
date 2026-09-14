import { applyOptions } from './snippets';

const COMPOSE = `services:
  glimt-agent:
    environment:
      GLIMT_TOKEN: agt_x
      # GLIMT_HEALTH_URL: http://127.0.0.1:8080/healthz
      # GLIMT_CHECKS: db=postgres:5432,cache=redis:6379
      # GLIMT_LOG_PATHS: /var/log/app
`;

const DOCKERFILE = `COPY --from=ghcr.io/opdahlmann/glimt-agent:latest /glimt-agent /usr/local/bin/glimt-agent
ENV GLIMT_HUB=wss://hub/agent/ws GLIMT_NODE_NAME=api-1
ENTRYPOINT ["/bin/sh", "-c", "glimt-agent run & exec \\"$0\\" \\"$@\\""]`;

describe('applyOptions', () => {
  it('compose: fyller de kommenterte linjene og lar tomme felt stå som kommentarer', () => {
    const out = applyOptions(COMPOSE, 'compose', { healthUrl: 'http://127.0.0.1:3000/healthz', checks: '', logPaths: ' /var/log/app ' });
    expect(out).toContain('      GLIMT_HEALTH_URL: http://127.0.0.1:3000/healthz');
    expect(out).toContain('      # GLIMT_CHECKS: db=postgres:5432,cache=redis:6379');
    expect(out).toContain('      GLIMT_LOG_PATHS: /var/log/app');
    expect(applyOptions(COMPOSE, 'compose', { healthUrl: '', checks: '', logPaths: '' })).toBe(COMPOSE);
  });

  it('dockerfile: legger en ENV-linje etter GLIMT_HUB, med anførselstegn ved mellomrom', () => {
    const out = applyOptions(DOCKERFILE, 'dockerfile', { healthUrl: 'http://127.0.0.1:8080/healthz', checks: 'db=postgres:5432, cache=redis:6379', logPaths: '' });
    const lines = out.split('\n');
    expect(lines[2]).toBe('ENV GLIMT_HEALTH_URL=http://127.0.0.1:8080/healthz GLIMT_CHECKS="db=postgres:5432, cache=redis:6379"');
    expect(lines[3].startsWith('ENTRYPOINT')).toBe(true);
    expect(applyOptions(DOCKERFILE, 'dockerfile', { healthUrl: '', checks: '', logPaths: '' })).toBe(DOCKERFILE);
  });
});
