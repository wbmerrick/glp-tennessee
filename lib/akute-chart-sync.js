const {
  getQuestionnaireResponse,
  getQuestionnaire,
  searchQuestionnaireResponses,
  searchTasks,
  addQuestionnaireItemToChart,
  requireEnv
} = require("./akute-client");

/** Intake part 2 — address + preferred pharmacy only. */
const SYNC_TYPES = ["address", "pharmacy"];
const ADDED_EXT = "questionnaireresponse-added-to-chart";
const FORM_TAG = "form submission";
/** Questionnaire inside the GLP Tennessee New Patient Intake bundle. */
const INTAKE_QUESTIONNAIRE_ID = "1190ffee-9e26-4dbf-bc63-dd07a7540377";

function questionnaireIdFromResponse(qr) {
  const ref = qr && qr.questionnaire && (qr.questionnaire.reference || qr.questionnaire);
  if (typeof ref !== "string") return "";
  const parts = ref.split("/");
  return parts[parts.length - 1] || "";
}

function flattenQuestionnaireItems(items, out) {
  if (!Array.isArray(items)) return out || [];
  out = out || [];
  items.forEach(function (item) {
    out.push(item);
    if (Array.isArray(item.item)) flattenQuestionnaireItems(item.item, out);
  });
  return out;
}

function findResponseItem(items, linkId) {
  if (!Array.isArray(items)) return null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.linkId === linkId) return item;
    const nested = findResponseItem(item.item, linkId);
    if (nested) return nested;
  }
  return null;
}

function answerAlreadyOnChart(answer) {
  if (!answer || !Array.isArray(answer.extension)) return false;
  return answer.extension.some(function (ext) {
    return typeof ext.url === "string"
      && ext.url.indexOf(ADDED_EXT) !== -1
      && ext.valueBoolean === true;
  });
}

/**
 * Build the list of address/pharmacy chart writes still needed for one
 * QuestionnaireResponse, using the Questionnaire's coded definitions.
 */
function planSyncActions(questionnaire, questionnaireResponse) {
  const actions = [];
  if (!questionnaire || !questionnaireResponse) return actions;
  const defs = flattenQuestionnaireItems(questionnaire.item).filter(function (item) {
    return item && SYNC_TYPES.indexOf(item.definition) !== -1;
  });
  defs.forEach(function (defItem) {
    const responseItem = findResponseItem(questionnaireResponse.item, defItem.linkId);
    if (!responseItem) return;

    // Address / pharmacy groups store values on child items. One chart write
    // covers the whole group (same as Akute's "Add to Patient Chart").
    if (defItem.definition === "pharmacy" || defItem.definition === "address") {
      const children = flattenQuestionnaireItems(responseItem.item);
      const answered = children.filter(function (child) {
        return Array.isArray(child.answer) && child.answer.length;
      });
      if (!answered.length && !(Array.isArray(responseItem.answer) && responseItem.answer.length)) {
        return;
      }
      const markers = [];
      if (Array.isArray(responseItem.answer)) {
        responseItem.answer.forEach(function (a) { markers.push(a); });
      }
      answered.forEach(function (child) {
        child.answer.forEach(function (a) { markers.push(a); });
      });
      if (markers.some(answerAlreadyOnChart)) return;
      actions.push({
        linkId: defItem.linkId,
        answerIndex: 0,
        resourceType: defItem.definition
      });
      return;
    }

    if (!Array.isArray(responseItem.answer) || !responseItem.answer.length) return;
    responseItem.answer.forEach(function (answer, answerIndex) {
      if (answerAlreadyOnChart(answer)) return;
      actions.push({
        linkId: defItem.linkId,
        answerIndex: answerIndex,
        resourceType: defItem.definition
      });
    });
  });
  return actions;
}

async function loadQuestionnaireForResponse(qr) {
  const qid = questionnaireIdFromResponse(qr) || INTAKE_QUESTIONNAIRE_ID;
  const result = await getQuestionnaire(qid);
  if (!result.ok) {
    return { ok: false, status: result.status, error: "questionnaire_fetch_failed", data: result.data };
  }
  return { ok: true, questionnaire: result.data, questionnaireId: qid };
}

/**
 * Sync home address + preferred pharmacy from one QuestionnaireResponse
 * onto the patient chart. Idempotent: skips answers already marked added.
 */
async function syncQuestionnaireResponseToChart(questionnaireResponseId, patientIdHint) {
  const userId = requireEnv("AKUTE_USER_ID");
  const qrResult = await getQuestionnaireResponse(questionnaireResponseId);
  if (!qrResult.ok) {
    return {
      ok: false,
      questionnaireResponseId,
      error: "questionnaire_response_fetch_failed",
      status: qrResult.status
    };
  }
  const qr = qrResult.data;
  const patientId = patientIdHint
    || (qr.subject && (qr.subject.reference || "").replace(/^Patient\//, ""))
    || "";
  if (!patientId) {
    return { ok: false, questionnaireResponseId, error: "missing_patient_id" };
  }

  const qResult = await loadQuestionnaireForResponse(qr);
  if (!qResult.ok) {
    return Object.assign({ questionnaireResponseId, patientId }, qResult);
  }

  const actions = planSyncActions(qResult.questionnaire, qr);
  const results = [];
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const response = await addQuestionnaireItemToChart(questionnaireResponseId, {
      linkId: action.linkId,
      answerIndex: action.answerIndex,
      patientId: patientId,
      userId: userId,
      resourceType: action.resourceType
    });
    results.push({
      resourceType: action.resourceType,
      linkId: action.linkId,
      answerIndex: action.answerIndex,
      status: response.status,
      ok: response.ok
    });
  }

  const failed = results.filter(function (r) { return !r.ok; });
  return {
    ok: failed.length === 0,
    questionnaireResponseId,
    patientId,
    planned: actions.length,
    applied: results.filter(function (r) { return r.ok; }).length,
    skipped: actions.length === 0,
    results: results
  };
}

function isFormSubmissionTask(task) {
  if (!task || typeof task !== "object") return false;
  const tags = task.tags || task.Tags || [];
  const hasTag = Array.isArray(tags) && tags.some(function (t) {
    return String(t).toLowerCase() === FORM_TAG;
  });
  const type = task.attachmentResourceType || task.attachment_resource_type || "";
  const resources = task.attachmentResources || task.attachment_resources || [];
  return hasTag
    && String(type).toLowerCase() === "questionnaireresponse"
    && Array.isArray(resources)
    && resources.length > 0;
}

function questionnaireResponseIdsFromTask(task) {
  const resources = task.attachmentResources || task.attachment_resources || [];
  return resources.map(String).filter(Boolean);
}

/**
 * Handle a tasks webhook payload (create/update). Syncs intake address +
 * pharmacy when the task is a form-submission attachment.
 */
async function syncFromTaskWebhook(payload) {
  const task = (payload && payload.data) || payload || {};
  if (!isFormSubmissionTask(task)) {
    return { ok: true, ignored: true, reason: "not_form_submission_task" };
  }
  const patientId = task.patient_id || task.patientId || payload.patient_id || "";
  const ids = questionnaireResponseIdsFromTask(task);
  const outcomes = [];
  for (let i = 0; i < ids.length; i++) {
    outcomes.push(await syncQuestionnaireResponseToChart(ids[i], patientId));
  }
  return {
    ok: outcomes.every(function (o) { return o.ok; }),
    synced: outcomes.length,
    outcomes: outcomes
  };
}

/**
 * Backup sweep: recent form-submission tasks, plus any questionnaire
 * responses for the intake form that still need chart writes.
 */
async function runBackupSweep(options) {
  options = options || {};
  const limit = options.limit || 50;
  const outcomes = [];
  const seen = Object.create(null);

  const tasks = await searchTasks({
    status: ["not-started", "in-progress", "completed"],
    limit: String(limit),
    offset: "0"
  });
  if (tasks.ok && Array.isArray(tasks.data)) {
    for (let i = 0; i < tasks.data.length; i++) {
      const task = tasks.data[i];
      if (!isFormSubmissionTask(task)) continue;
      const ids = questionnaireResponseIdsFromTask(task);
      const patientId = task.patient_id || task.patientId || "";
      for (let j = 0; j < ids.length; j++) {
        if (seen[ids[j]]) continue;
        seen[ids[j]] = true;
        outcomes.push(await syncQuestionnaireResponseToChart(ids[j], patientId));
      }
    }
  }

  // Also catch responses that never produced a task (or lost the tag).
  const qrs = await searchQuestionnaireResponses({
    questionnaire: "Questionnaire/" + INTAKE_QUESTIONNAIRE_ID,
    _count: String(limit)
  });
  if (qrs.ok) {
    const bundle = qrs.data;
    const entries = Array.isArray(bundle)
      ? bundle
      : (bundle && Array.isArray(bundle.entry) ? bundle.entry.map(function (e) { return e.resource; }) : []);
    for (let i = 0; i < entries.length; i++) {
      const qr = entries[i];
      if (!qr || !qr.id || seen[qr.id]) continue;
      seen[qr.id] = true;
      outcomes.push(await syncQuestionnaireResponseToChart(qr.id));
    }
  }

  const failed = outcomes.filter(function (o) { return !o.ok; });
  return {
    ok: failed.length === 0,
    scanned: outcomes.length,
    applied: outcomes.reduce(function (n, o) { return n + (o.applied || 0); }, 0),
    outcomes: outcomes
  };
}

module.exports = {
  SYNC_TYPES,
  ADDED_EXT,
  FORM_TAG,
  INTAKE_QUESTIONNAIRE_ID,
  planSyncActions,
  isFormSubmissionTask,
  questionnaireResponseIdsFromTask,
  syncQuestionnaireResponseToChart,
  syncFromTaskWebhook,
  runBackupSweep
};
