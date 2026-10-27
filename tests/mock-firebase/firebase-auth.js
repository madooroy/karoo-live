// Test double for firebase-auth.js: anonymous sign-in only. window.__MOCK_NO_ANON makes it fail like a
// project where the Anonymous provider isn't enabled.
export function getAuth(app) { return (app.__auth ||= { app, currentUser: null }); }
export async function signInAnonymously(auth) {
  if (window.__MOCK_NO_ANON) { const e = new Error("auth/operation-not-allowed"); e.code = "auth/operation-not-allowed"; throw e; }
  auth.currentUser = { uid: "anon-" + (window.__MOCK_UID || "viewer1"), isAnonymous: true };
  return { user: auth.currentUser };
}
