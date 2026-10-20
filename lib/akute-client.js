const API_BASE = "https://api.akutehealth.com";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    const error = new Error("missing_env");
    error.code = "missing_env";
    error.env = name;
    throw error;
  }
  return value;
}

function headers() {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-API-Key": requireEnv("AKUTE_API_KEY")
  };
}

async function akuteRequest(method, path, body) {
  const response = await fetch(API_BASE + path, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch (e) { data = { raw: text }; }
  }
  return { status: response.status, ok: response.ok, data };
}

function getQuestionnaireResponse(id) {
  return akuteRequest("GET", "/3_0_1/questionnaireResponse/" + encodeURIComponent(id));
}

function searchQuestionnaireResponses(query) {
  const qs = new URLSearchParams(query || {}).toString();
  return akuteRequest("GET", "/3_0_1/questionnaireResponse?" + qs);
}

function getQuestionnaire(id) {
  return akuteRequest("GET", "/3_0_1/questionnaire/" + encodeURIComponent(id));
}

function searchTasks(query) {
  const qs = new URLSearchParams();
  Object.keys(query || {}).forEach(function (key) {
    const value = query[key];
    if (Array.isArray(value)) value.forEach(function (v) { qs.append(key, v); });
    else if (value !== undefined && value !== null && value !== "") qs.append(key, value);
  });
  return akuteRequest("GET", "/v1/tasks?" + qs.toString());
}

/**
 * Applies one coded form answer (address / pharmacy / …) onto the patient chart.
 * Same endpoint the Akute UI hits for "Add to Patient Chart".
 */
function addQuestionnaireItemToChart(questionnaireResponseId, payload) {
  return akuteRequest(
    "POST",
    "/questionnaireResponse/" + encodeURIComponent(questionnaireResponseId) + "/items/add",
    payload
  );
}

module.exports = {
  API_BASE,
  akuteRequest,
  getQuestionnaireResponse,
  searchQuestionnaireResponses,
  getQuestionnaire,
  searchTasks,
  addQuestionnaireItemToChart,
  requireEnv
};
