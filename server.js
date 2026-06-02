import express from "express";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const {
  AMO_DOMAIN,
  AMO_TOKEN,
  PIPELINE_ID,
  SUCCESS_STATUS_ID,
  REPEAT_CONTACT_STATUS_ID,
  NEW_SUCCESS_LEAD_STATUS_ID,
  PHONE_FIELD_ID,
  RGP_USER_ID
} = process.env;

const api = axios.create({
  baseURL: `https://${AMO_DOMAIN}.amocrm.ru/api/v4`,
  headers: {
    Authorization: `Bearer ${AMO_TOKEN}`,
    "Content-Type": "application/json"
  }
});

function normalizePhone(phone) {
  if (!phone) return null;

  let value = String(phone).replace(/\D/g, "");

  if (value.startsWith("8")) {
    value = "7" + value.substring(1);
  }

  return value;
}

async function getLead(leadId) {
  const { data } = await api.get(`/leads/${leadId}`, {
    params: {
      with: "contacts"
    }
  });

  return data;
}

async function getContact(contactId) {
  const { data } = await api.get(`/contacts/${contactId}`);

  return data;
}

function getPhoneFromContact(contact) {
  const field = contact.custom_fields_values?.find(
    f => Number(f.field_id) === Number(PHONE_FIELD_ID)
  );

  if (!field?.values?.length) {
    return null;
  }

  return field.values[0].value;
}

async function getPhoneFromLead(lead) {
  const contactId = lead._embedded?.contacts?.[0]?.id;

  if (!contactId) {
    return null;
  }

  const contact = await getContact(contactId);

  return getPhoneFromContact(contact);
}

async function getContactLeads(contactId) {
  const { data } = await api.get(`/contacts/${contactId}`, {
    params: {
      with: "leads"
    }
  });

  return data._embedded?.leads || [];
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

async function createTask(leadId, responsibleUserId, text) {
  const completeTill =
    Math.floor(Date.now() / 1000) + 3600;

  await api.post("/tasks", [
    {
      text,
      entity_id: Number(leadId),
      entity_type: "leads",
      responsible_user_id: Number(responsibleUserId),
      complete_till: completeTill
    }
  ]);
}

function daysBetween(unixCreatedAt) {
  return (
    (Date.now() - unixCreatedAt * 1000) /
    (1000 * 60 * 60 * 24)
  );
}

app.post("/webhook", async (req, res) => {
  try {
    const leadId =
      req.body?.leads?.add?.[0]?.id ||
      req.body?.leads?.status?.[0]?.id;

    if (!leadId) {
      return res.sendStatus(200);
    }

    await new Promise(resolve =>
      setTimeout(resolve, 5000)
    );

    const newLead = await getLead(leadId);

    if (
      Number(newLead.pipeline_id) !==
      Number(PIPELINE_ID)
    ) {
      return res.sendStatus(200);
    }

    const contactId =
      newLead._embedded?.contacts?.[0]?.id;

    if (!contactId) {
      return res.sendStatus(200);
    }

    const phone = await getPhoneFromLead(newLead);

    if (!phone) {
      return res.sendStatus(200);
    }

    const normalizedPhone =
      normalizePhone(phone);

    const relatedLeads =
      await getContactLeads(contactId);

    const nonSuccessLeads = [];
    let hasSuccessfulLead = false;

    for (const shortLead of relatedLeads) {
      if (
        Number(shortLead.id) ===
        Number(newLead.id)
      ) {
        continue;
      }

      const lead = await getLead(shortLead.id);

      if (
        Number(lead.pipeline_id) !==
        Number(PIPELINE_ID)
      ) {
        continue;
      }

      const leadPhone =
        await getPhoneFromLead(lead);

      if (!leadPhone) {
        continue;
      }

      if (
        normalizePhone(leadPhone) !==
        normalizedPhone
      ) {
        continue;
      }

      if (
        Number(lead.status_id) ===
        Number(SUCCESS_STATUS_ID)
      ) {
        hasSuccessfulLead = true;
        continue;
      }

      nonSuccessLeads.push(lead);
    }

    const firstNonSuccessLead =
      nonSuccessLeads.sort(
        (a, b) => a.created_at - b.created_at
      )[0];

    if (firstNonSuccessLead) {
      const days =
        daysBetween(firstNonSuccessLead.created_at);

      if (days <= 30) {
        await deleteLead(newLead.id);

        await moveLead(
          firstNonSuccessLead.id,
          REPEAT_CONTACT_STATUS_ID
        );

        const taskText =
          "Повторное обращение клиента в течение 30 дней. Необходимо связаться с клиентом.";

        await createTask(
          firstNonSuccessLead.id,
          firstNonSuccessLead.responsible_user_id,
          taskText
        );

        await createTask(
          firstNonSuccessLead.id,
          RGP_USER_ID,
          taskText
        );

        return res.sendStatus(200);
      }
    }

    if (hasSuccessfulLead) {
      await moveLead(
        newLead.id,
        NEW_SUCCESS_LEAD_STATUS_ID
      );
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error(
      error?.response?.data || error.message
    );

    return res.sendStatus(200);
  }
});

app.get("/", (_, res) => {
  res.send("OK");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server started on ${PORT}`);
});
