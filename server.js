import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const {
  AMO_DOMAIN,
  AMO_TOKEN,
  PIPELINE_ID,
  PHONE_FIELD_ID,
  RGP_USER_ID
} = process.env;

const SUCCESS_STATUS_ID = 142;
const FAILED_STATUS_ID = 143;
const TARGET_STATUS_ID = 47054479;

const api = axios.create({
  baseURL: `https://${AMO_DOMAIN}.amocrm.ru/api/v4`,
  headers: {
    Authorization: `Bearer ${AMO_TOKEN}`,
    "Content-Type": "application/json"
  }
});

function normalizePhone(phone) {
  if (!phone) return null;

  let p = String(phone).replace(/\D/g, "");

  if (p.startsWith("8")) {
    p = "7" + p.slice(1);
  }

  return p;
}

async function getLead(id) {
  const { data } = await api.get(`/leads/${id}`, {
    params: {
      with: "contacts"
    }
  });

  return data;
}

async function getContact(id) {
  const { data } = await api.get(`/contacts/${id}`);
  return data;
}

function getPhoneFromContact(contact) {
  const field =
    contact.custom_fields_values?.find(
      x => Number(x.field_id) === Number(PHONE_FIELD_ID)
    );

  if (!field?.values?.length) {
    return null;
  }

  return field.values[0].value;
}

async function getPhoneFromLead(lead) {
  const contactId =
    lead._embedded?.contacts?.[0]?.id;

  if (!contactId) {
    return null;
  }

  const contact = await getContact(contactId);

  return getPhoneFromContact(contact);
}

async function moveLead(leadId, statusId) {
  await api.patch("/leads", [
    {
      id: Number(leadId),
      status_id: Number(statusId)
    }
  ]);
}

async function deleteLead(leadId) {
  await api.delete(`/leads/${leadId}`);
}

async function createTask(
  leadId,
  responsibleId,
  text
) {
  await api.post("/tasks", [
    {
      text,
      entity_id: Number(leadId),
      entity_type: "leads",
      responsible_user_id: Number(responsibleId),
      complete_till:
        Math.floor(Date.now() / 1000) + 3600
    }
  ]);
}

async function findAllLeadsByPhone(phone) {

  const result = [];

  const search = await api.get("/contacts", {
    params: {
      query: phone
    }
  });

  const contacts =
    search.data?._embedded?.contacts || [];

  for (const contact of contacts) {

    const contactPhone =
      normalizePhone(
        getPhoneFromContact(contact)
      );

    if (contactPhone !== phone) {
      continue;
    }

    const fullContact = await api.get(
      `/contacts/${contact.id}`,
      {
        params: {
          with: "leads"
        }
      }
    );

    const leads =
      fullContact.data?._embedded?.leads || [];

    for (const lead of leads) {

      try {

        const fullLead =
          await getLead(lead.id);

        result.push(fullLead);

      } catch (e) {
        console.error(
          "Lead load error:",
          lead.id
        );
      }
    }
  }

  return result;
}

async function processLead(newLead) {

  const phone =
    await getPhoneFromLead(newLead);

  if (!phone) {
    console.log("phone not found");
    return;
  }

  const normalizedPhone =
    normalizePhone(phone);

  const allLeads =
    await findAllLeadsByPhone(
      normalizedPhone
    );

  const candidates = [];

  for (const lead of allLeads) {

    if (
      Number(lead.id) ===
      Number(newLead.id)
    ) {
      continue;
    }

    if (
      Number(lead.pipeline_id) !==
      Number(PIPELINE_ID)
    ) {
      continue;
    }

    const diffDays =
      (newLead.created_at -
        lead.created_at) /
      86400;

    if (diffDays < 0) {
      continue;
    }

    if (diffDays > 30) {
      continue;
    }

    candidates.push(lead);
  }

  if (!candidates.length) {
    console.log(
      "no leads in last 30 days"
    );
    return;
  }

  candidates.sort(
    (a, b) =>
      a.created_at - b.created_at
  );

  const oldestLead =
    candidates[0];

  if (
    Number(oldestLead.status_id) ===
    FAILED_STATUS_ID
  ) {

    await deleteLead(newLead.id);

    await moveLead(
      oldestLead.id,
      TARGET_STATUS_ID
    );

    const taskText =
      "Повторное обращение клиента в течение 30 дней.";

    await createTask(
      oldestLead.id,
      oldestLead.responsible_user_id,
      taskText
    );

    await createTask(
      oldestLead.id,
      Number(RGP_USER_ID),
      taskText
    );

    console.log(
      "duplicate processed"
    );

    return;
  }

  if (
    Number(oldestLead.status_id) ===
    SUCCESS_STATUS_ID
  ) {

    await moveLead(
      newLead.id,
      TARGET_STATUS_ID
    );

    console.log(
      "successful lead found"
    );

    return;
  }
}

app.post(
  "/webhook",
  async (req, res) => {

    try {

      console.log(
        "Webhook:",
        JSON.stringify(
          req.body,
          null,
          2
        )
      );

      const leadId =
        req.body?.leads?.add?.[0]?.id ||
        req.body?.leads?.status?.[0]?.id;

      if (!leadId) {
        return res.sendStatus(200);
      }

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            5000
          )
      );

      const newLead =
        await getLead(leadId);

      if (
        Number(
          newLead.pipeline_id
        ) !==
        Number(
          PIPELINE_ID
        )
      ) {
        return res.sendStatus(200);
      }

      await processLead(
        newLead
      );

      return res.sendStatus(200);

    } catch (e) {

      console.error(
        e.response?.data ||
        e.message
      );

      return res.sendStatus(200);
    }
  }
);

app.get(
  "/",
  (_, res) =>
    res.send("OK")
);

app.listen(
  process.env.PORT || 3000,
  () =>
    console.log(
      "Server started"
    )
);
