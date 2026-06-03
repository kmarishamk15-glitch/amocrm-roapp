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

// ID статусов (проверьте их актуальность в вашей воронке!)
const SUCCESS_STATUS_ID = 142; // Успешная сделка
const FAILED_STATUS_ID = 143;  // Отказ/Закрыто
const TARGET_STATUS_ID = 47054479; // Куда переводим дубль

// --- AXIOS INSTANCE ---
const api = axios.create({
  baseURL: `https://${AMO_DOMAIN}.amocrm.ru/api/v4`,
  headers: {
    Authorization: `Bearer ${AMO_TOKEN}`,
    "Content-Type": "application/json"
  }
});

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---

function normalizePhone(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/\D/g, "");
  if (p.startsWith("8")) {
    p = "7" + p.slice(1);
  }
  if (p.length < 11) return null; // Слишком короткий номер
  return p;
}

async function getLead(id) {
  try {
    const { data } = await api.get(`/leads/${id}`, {
      params: { with: "contacts" }
    });
    return data;
  } catch (error) {
    console.error(`❌ Error fetching lead ${id}:`, error.message);
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
  
  const field = contact.custom_fields_values.find(
    x => Number(x.field_id) === Number(PHONE_FIELD_ID)
  );

  return field?.values?.[0]?.value || null;
}

async function getPhoneFromLead(lead) {
  // Если контакты уже подгружены через ?with=contacts
  if (lead._embedded?.contacts?.length > 0) {
    const contactId = lead._embedded.contacts[0].id;
    const contact = await getContact(contactId);
    return getPhoneFromContact(contact);
  }
  return null;
}

async function moveLead(leadId, statusId) {
  try {
    await api.patch("/leads", [
      { id: Number(leadId), status_id: Number(statusId) }
    ]);
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
    console.log(`📝 Task created for lead ${leadId}`);
  } catch (error) {
    console.error(`❌ Error creating task:`, error.message);
  }
}

async function findAllLeadsByPhone(phone) {
  const result = [];
  if (!phone) return result;

  try {
    // 1. Ищем контакты по номеру
    const search = await api.get("/contacts", {
      params: { query: phone }
    });

    const contacts = search.data?._embedded?.contacts || [];

    for (const contact of contacts) {
      // Проверяем точное совпадение (поиск amoCRM может быть неточным)
      const contactPhone = normalizePhone(getPhoneFromContact(contact));
      if (contactPhone !== phone) continue;

      // 2. Получаем лиды этого контакта
      const fullContact = await api.get(`/contacts/${contact.id}`, {
        params: { with: "leads" }
      });

      const leads = fullContact.data?._embedded?.leads || [];

      for (const lead of leads) {
        const fullLead = await getLead(lead.id);
        if (fullLead) result.push(fullLead);
      }
    }
  } catch (error) {
    console.error("❌ Error in findAllLeadsByPhone:", error.message);
  }

  return result;
}

// --- ОСНОВНАЯ ЛОГИКА ---

async function processLead(newLead) {
  console.log(`\n>>> START PROCESSING LEAD: ${newLead.id}`);
  console.log(`    Pipeline: ${newLead.pipeline_id} | Status: ${newLead.status_id}`);

  // 1. Проверка воронки
  if (Number(newLead.pipeline_id) !== Number(PIPELINE_ID)) {
    console.log("    ️ SKIP: Wrong pipeline");
    return;
  }

  // 2. Получение телефона
  const phone = await getPhoneFromLead(newLead);
  if (!phone) {
    console.log("    ⏭️ SKIP: No phone number found in lead/contact");
    return;
  }

  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    console.log("    ⏭️ SKIP: Invalid phone format");
    return;
  }

  console.log(`    🔍 Searching duplicates for: ${normalizedPhone}`);

  // 3. Поиск всех лидов с этим телефоном
  const allLeads = await findAllLeadsByPhone(normalizedPhone);
  const candidates = [];

  for (const lead of allLeads) {
    // Пропускаем сам новый лид
    if (Number(lead.id) === Number(newLead.id)) continue;
    
    // Пропускаем лиды из других воронок
    if (Number(lead.pipeline_id) !== Number(PIPELINE_ID)) continue;

    // Проверяем временной интервал (0 - 30 дней назад)
    const diffDays = (Number(newLead.created_at) - Number(lead.created_at)) / 86400;
    
    // lead.created_at должен быть <= newLead.created_at (diffDays >= 0)
    // и не старше 30 дней (diffDays <= 30)
    if (diffDays >= 0 && diffDays <= 30) {
      candidates.push(lead);
    }
  }

  // 4. Анализ результатов
  if (candidates.length === 0) {
    console.log("    ✅ RESULT: No duplicates found in last 30 days.");
    return;
  }

  // Сортируем: самый старый первый
  candidates.sort((a, b) => Number(a.created_at) - Number(b.created_at));
  const oldestLead = candidates[0];

  console.log(`    🎯 FOUND OLDEST LEAD: ${oldestLead.id} | Status: ${oldestLead.status_id}`);

  // 5. Действия в зависимости от статуса старого лида
  if (Number(oldestLead.status_id) === FAILED_STATUS_ID) {
    console.log("    ⚡ ACTION: Oldest is FAILED. Restoring old, deleting new.");
    try {
      await deleteLead(newLead.id);
      await moveLead(oldestLead.id, TARGET_STATUS_ID);
      
      const taskText = "Повторное обращение клиента (возврат из отказа).";
      await createTask(oldestLead.id, oldestLead.responsible_user_id, taskText);
      if (RGP_USER_ID) {
        await createTask(oldestLead.id, Number(RGP_USER_ID), taskText);
      }
    } catch (e) {
      console.error("❌ Critical error processing FAILED duplicate:", e);
    }

  } else if (Number(oldestLead.status_id) === SUCCESS_STATUS_ID) {
    console.log("    ⚡ ACTION: Oldest is SUCCESS. Moving new to target status.");
    try {
      await moveLead(newLead.id, TARGET_STATUS_ID);
      const taskText = "Повторное обращение клиента (уже была успешная сделка).";
      await createTask(newLead.id, newLead.responsible_user_id, taskText);
    } catch (e) {
      console.error("❌ Critical error processing SUCCESS duplicate:", e);
    }

  } else {
    console.log(`    ️ SKIP: Oldest lead status (${oldestLead.status_id}) is not Failed or Success.`);
  }
}

// --- WEBHOOK HANDLER ---

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    
    // Игнорируем служебные уведомления (например, account.subdomain)
    if (!body.leads) {
      return res.sendStatus(200);
    }

    // Извлекаем ID лида из разных типов событий
    let leadId = null;
    let eventType = "";

    if (body.leads.add && body.leads.add.length > 0) {
      leadId = body.leads.add[0].id;
      eventType = "add";
    } else if (body.leads.update && body.leads.update.length > 0) {
      leadId = body.leads.update[0].id;
      eventType = "update";
    } else if (body.leads.status && body.leads.status.length > 0) {
      leadId = body.leads.status[0].id;
      eventType = "status";
    }

    if (!leadId) {
      return res.sendStatus(200);
    }

    console.log(`\n Webhook received: ${eventType} | Lead ID: ${leadId}`);

    // Небольшая задержка для гарантированного сохранения данных в БД amoCRM
    await new Promise(resolve => setTimeout(resolve, 1000));

    const newLead = await getLead(leadId);
    if (!newLead) {
      console.log(" Lead not found after delay");
      return res.sendStatus(200);
    }

    // Запускаем обработку асинхронно, чтобы быстро ответить amoCRM
    processLead(newLead).catch(err => console.error("Unhandled processLead error:", err));

    return res.sendStatus(200);

  } catch (e) {
    console.error("❌ Webhook handler error:", e.message);
    return res.sendStatus(200); // Всегда возвращаем 200, чтобы не зациклить вебхук
  }
});

app.get("/", (_, res) => res.send("OK"));

app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
});
