const test = require("node:test");
const assert = require("node:assert/strict");
const {
  planSyncActions,
  isFormSubmissionTask,
  questionnaireResponseIdsFromTask,
  INTAKE_QUESTIONNAIRE_ID
} = require("./akute-chart-sync");
const { verifyAkuteSignature } = require("./akute-webhook");

const questionnaire = {
  id: INTAKE_QUESTIONNAIRE_ID,
  item: [
    {
      linkId: "home-address",
      definition: "address",
      type: "group",
      item: [
        { linkId: "address-line-1", type: "string" },
        { linkId: "address-line-2", type: "string" },
        { linkId: "address-city", type: "string" },
        { linkId: "address-state", type: "choice" },
        { linkId: "address-zip", type: "string" }
      ]
    },
    {
      linkId: "preferred-pharmacy",
      definition: "pharmacy",
      type: "group",
      item: [
        { linkId: "pharmacy-search", type: "string" },
        { linkId: "pharmacy-name", type: "string" },
        { linkId: "pharmacy-id", type: "string" }
      ]
    }
  ]
};

function responseWithAnswers(opts) {
  opts = opts || {};
  return {
    id: "qr-1",
    resourceType: "QuestionnaireResponse",
    questionnaire: { reference: "Questionnaire/" + INTAKE_QUESTIONNAIRE_ID },
    subject: { reference: "Patient/pat-1" },
    item: [
      {
        linkId: "home-address",
        item: [
          { linkId: "address-line-1", answer: [{ valueString: "123 Main St" }] },
          { linkId: "address-city", answer: [{ valueString: "Nashville" }] },
          { linkId: "address-state", answer: [{ valueCoding: { code: "TN" } }] },
          { linkId: "address-zip", answer: [{ valueString: "37201" }] }
        ]
      },
      {
        linkId: "preferred-pharmacy",
        item: [
          { linkId: "pharmacy-name", answer: [{ valueString: "CVS" }] },
          {
            linkId: "pharmacy-id",
            answer: [{
              valueString: "999",
              extension: opts.pharmacyAlreadyAdded
                ? [{ url: "https://api.akutehealth.com/fhir/StructureDefinition/questionnaireresponse-added-to-chart", valueBoolean: true }]
                : undefined
            }]
          }
        ]
      }
    ]
  };
}

test("plans address and pharmacy chart writes from the intake questionnaire", function () {
  const actions = planSyncActions(questionnaire, responseWithAnswers());
  assert.deepEqual(actions.map(function (a) { return a.resourceType; }).sort(), ["address", "pharmacy"]);
  assert.equal(actions.every(function (a) { return a.answerIndex === 0; }), true);
});

test("skips pharmacy when it is already marked added-to-chart", function () {
  const actions = planSyncActions(questionnaire, responseWithAnswers({ pharmacyAlreadyAdded: true }));
  assert.deepEqual(actions.map(function (a) { return a.resourceType; }), ["address"]);
});

test("recognizes form-submission tasks and their QuestionnaireResponse ids", function () {
  assert.equal(isFormSubmissionTask({
    tags: ["form submission"],
    attachmentResourceType: "QuestionnaireResponse",
    attachmentResources: ["qr-abc"],
    patientId: "pat-1"
  }), true);
  assert.equal(isFormSubmissionTask({
    tags: ["other"],
    attachmentResourceType: "QuestionnaireResponse",
    attachmentResources: ["qr-abc"]
  }), false);
  assert.deepEqual(questionnaireResponseIdsFromTask({
    attachmentResources: ["qr-1", "qr-2"]
  }), ["qr-1", "qr-2"]);
});

test("verifies Akute webhook HMAC signatures", function () {
  const body = Buffer.from('{"event_type":"create","resource_type":"tasks"}');
  const secret = "whsec_test";
  const crypto = require("crypto");
  const hex = crypto.createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifyAkuteSignature(body, hex, secret), true);
  assert.equal(verifyAkuteSignature(body, "sha256=" + hex, secret), true);
  assert.equal(verifyAkuteSignature(body, "deadbeef", secret), false);
  assert.equal(verifyAkuteSignature(body, hex, "wrong"), false);
});
