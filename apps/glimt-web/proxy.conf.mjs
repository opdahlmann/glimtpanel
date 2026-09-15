// Dev-proxy for `ng serve`: /api og /hub sendes til huben (GLIMT_HUB_INTERNAL_URL, standard http://localhost:5080).
// Samme regel som infra/glimt-web/nginx.conf bruker i containeren, slik at nettleseren alltid snakker same-origin.
const target = process.env.GLIMT_HUB_INTERNAL_URL || 'http://localhost:5080';

export default {
  '/api': { target, changeOrigin: true, ws: true },
  '/hub': { target, changeOrigin: true, ws: true },
};
