// Test double for https://www.gstatic.com/firebasejs/<v>/firebase-app.js (only what the viewer uses).
const apps = new Map();
export function initializeApp(options, name = "[DEFAULT]") {
  if (apps.has(name)) throw new Error(`Firebase App named '${name}' already exists`);
  const app = { name, options };
  apps.set(name, app);
  (window.__mockFirebase ||= { apps: [], listeners: [] }).apps.push({ name, databaseURL: options.databaseURL });
  return app;
}
export function getApps() { return [...apps.values()]; }
