// Docker HEALTHCHECK: exit 0 when GET /health answers with a 2xx status, 1 otherwise.
const port = process.env.HTTP_PORT || 8080;

fetch(`http://127.0.0.1:${port}/health`).then(
  (response) => process.exit(response.ok ? 0 : 1),
  () => process.exit(1),
);
