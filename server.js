import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- КОНФИГУРАЦИЯ ---
const {
  AMO_DOMAIN,
  AMO_TOKEN,
  PIPELINE_ID,
  PHONE_FIELD_ID,
  RGP_USER_ID
} = process.env;

if (!AMO_DOMAIN || !AMO_TOKEN || !PIPELINE_ID || !PHONE_FIELD_ID) {
  console.error("❌ Ошибка: Не все переменные окружения заданы (.env)");
  process.exit(1);
}

const SUCCESS_STATUS_ID = 142;
const FAILED_STATUS_ID = 143;
const TARGET_STATUS_ID = 47054479;

// --- AXIOS INSTANCE ---
const api = axios.create({
  baseURL: `https://${AMO_DOMAIN}.amocrm.ru/api/v4`,
  headers: {
    Authorization: `Bearer ${AMO_TOKEN}`,
    "Content-Type": "application/json"
  },
  timeout: 5000 // 5 секунд макс на один запрос к API
});

function normalizePhone(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/\D/g, "");
  if (p.startsWith("8")) p = "7" + p.slice(1);
  if (p.length < 11) return null;
  return p;
}

async function getLead(id) {
  try {
    const { data } = await api.get(`/leads/${id}`, { params: { with: "contacts" } });
    return data;
  } catch (error) {
    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
        console.error(`️ Timeout fetching lead ${id}`);
    } else {
        console.error(`❌ Error fetching lead ${id}:`, error.message);
    }
    return null;
  }
}

async function getContact(id) {
  try {
    const { data } = await api.get(`/contacts/${id}`);
    return data;
  } catch (error) {
    return null;
  }
}

function getPhoneFromContact(contact) {
  if (!contact?.custom_fields_values) return null;
  const field = contact.custom_fields_values.find(x => Number(x.field_id) === Number(PHONE_FIELD_ID));
  return field?.values?.[0]?.value || null;
}

async function getPhoneFromLead(lead) {
  if (lead._embedded?.contacts?.length > 0) {
    const contactId = lead._embedded.contacts[0].id;
    const contact = await getContact(contactId);
    return getPhoneFromContact(contact);
  }
  return null;
}

async function moveLead(leadId, statusId) {
  try {
    await api.patch("/leads", [{ id: Number(leadId), status_id: Number(statusId) }]);
    console.log(`✅ Lead ${leadId} moved to status ${statusId}`);
  } catch (error) {
    console.error(`❌ Error moving lead ${leadId}:`, error.response?.data || error.message);
  }
}

async function deleteLead(leadId) {
  try {
    await api.delete(`/leads/${leadId}`);
    console.log(`🗑️ Lead ${leadId} deleted`);
  } catch (error) {
    console.error(`❌ Error deleting lead ${leadId}:`, error.response?.data || error.message);
  }
}

async function createTask(leadId, responsibleId, text) {
  if (!responsibleId) return;
  try {
    await api.post("/tasks", [
      {
        text,
        entity_id: Number(leadId),
        entity_type: "leads",
        responsible_user_id: Number(responsibleId),
        complete_till: Math.floor(Date.now() / 1000) + 3600
      }
    ]);
    console.log(` Task created for lead ${leadId}`);
  } catch (error) {
    console.error(`❌ Error creating task:`, error.message);
  }
}

async function findAllLeadsByPhone(phone) {
  const result = [];
  if (!phone) return result;

  try {
    const search = await api.get("/contacts", { params: { query: phone } });
    const contacts = search.data?._embedded?.contacts || [];

    for (const contact of contacts) {
      const contactPhone = normalizePhone(getPhoneFromContact(contact));
      if (contactPhone !== phone) continue;

      const fullContact = await api.get(`/contacts/${contact.id}`, { params: { with: "leads" } });
      const leadsInfo = fullContact.data?._embedded?.leads || [];

      for (const leadInfo of leadsInfo) {
        if (Number(leadInfo.pipeline_id) !== Number(PIPELINE_ID)) continue;
        
        // Ограничиваем количество одновременных запросов, чтобы не повесить всё
        // Здесь мы просто делаем запросы последовательно, но с таймаутом внутри getLead
        const fullLead = await getLead(leadInfo.id);
        if (fullLead) result.push(fullLead);
      }
    }
  } catch (error) {
    console.error("❌ Error in findAllLeadsByPhone:", error.message);
  }

  return result;
}

async function processLead(newLead) {
  console.log(`>>> START PROCESSING LEAD: ${newLead.id} | Time: ${new Date().toISOString()}`);
  
  if (Number(newLead.pipeline_id) !== Number(PIPELINE_ID)) {
    console.log("    SKIP: Wrong pipeline");
    return;
  }

  const phone = await getPhoneFromLead(newLead);
  if (!phone) {
    console.log("    SKIP: No phone number found");
    return;
  }

  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    console.log("    SKIP: Invalid phone format");
    return;
  }

  console.log(`    SEARCHING duplicates for: ${normalizedPhone}`);

  const allLeads = await findAllLeadsByPhone(normalizedPhone);
  const candidates = [];

  for (const lead of allLeads) {
    if (Number(lead.id) === Number(newLead.id)) continue;
    if (Number(lead.pipeline_id) !== Number(PIPELINE_ID)) continue;

    const diffDays = (Number(newLead.created_at) - Number(lead.created_at)) / 86400;
    if (diffDays >= 0 && diffDays <= 30) {
      candidates.push(lead);
    }
  }

  if (candidates.length === 0) {
    console.log("    RESULT: No duplicates found in last 30 days.");
    return;
  }

  candidates.sort((a, b) => Number(a.created_at) - Number(b.created_at));
  const oldestLead = candidates[0];

  console.log(`    FOUND OLDEST LEAD: ${oldestLead.id} | Status: ${oldestLead.status_id}`);

  if (Number(oldestLead.status_id) === FAILED_STATUS_ID) {
    console.log("    ACTION: Oldest is FAILED. Restoring old, deleting new.");
    try {
      await deleteLead(newLead.id);
      await moveLead(oldestLead.id, TARGET_STATUS_ID);
      const taskText = "Повторное обращение клиента (возврат из отказа).";
      await createTask(oldestLead.id, oldestLead.responsible_user_id, taskText);
      if (RGP_USER_ID) await createTask(oldestLead.id, Number(RGP_USER_ID), taskText);
    } catch (e) {
      console.error(" Critical error processing FAILED duplicate:", e);
    }

  } else if (Number(oldestLead.status_id) === SUCCESS_STATUS_ID) {
    console.log("    ACTION: Oldest is SUCCESS. Moving new to target status.");
    try {
      await moveLead(newLead.id, TARGET_STATUS_ID);
      const taskText = "Повторное обращение клиента (уже была успешная сделка).";
      await createTask(newLead.id, newLead.responsible_user_id, taskText);
    } catch (e) {
      console.error("❌ Critical error processing SUCCESS duplicate:", e);
    }

  } else {
    console.log(`    SKIP: Oldest lead status (${oldestLead.status_id}) is not Failed or Success.`);
  }
  
  console.log(`>>> END PROCESSING LEAD: ${newLead.id} | Time: ${new Date().toISOString()}`);
}

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    if (!body.leads) return res.sendStatus(200);

    let leadId = null;
    if (body.leads.add?.[0]) leadId = body.leads.add[0].id;
    else if (body.leads.update?.[0]) leadId = body.leads.update[0].id;
    else if (body.leads.status?.[0]) leadId = body.leads.status[0].id;

    if (!leadId) return res.sendStatus(200);

    console.log(`\n[WEBHOOK] Received: Lead ID ${leadId} at ${new Date().toISOString()}`);

    // Уменьшил задержку до 1 сек, чтобы быстрее начать обработку
    await new Promise(resolve => setTimeout(resolve, 1000));

    const newLead = await getLead(leadId);
    if (!newLead) {
      console.log("[WEBHOOK] Lead not found after delay");
      return res.sendStatus(200);
    }

    // Важно: отвечаем amoCRM СРАЗУ, а обработку запускаем в фоне
    res.sendStatus(200);

    // Запускаем обработку
    processLead(newLead).catch(err => {
        console.error("❌ Unhandled error in processLead:", err);
    });

  } catch (e) {
    console.error("❌ Webhook handler error:", e.message);
    res.sendStatus(200);
  }
});

app.get("/", (_, res) => res.send("OK"));

app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT} at ${new Date().toISOString()}`);
});
