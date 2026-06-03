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

// Проверка наличия обязательных переменных
if (!AMO_DOMAIN || !AMO_TOKEN || !PIPELINE_ID || !PHONE_FIELD_ID) {
  console.error("Missing required environment variables");
  process.exit(1);
}

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
  // Если номер короче 11 цифр, возможно, это не полный номер
  if (p.length < 11) return null;
  return p;
}

async function getLead(id) {
  try {
    const { data } = await api.get(`/leads/${id}`, {
      params: {
        with: "contacts"
      }
    });
    return data;
  } catch (error) {
    console.error(`Error fetching lead ${id}:`, error.message);
    throw error;
  }
}

async function getContact(id) {
  try {
    const { data } = await api.get(`/contacts/${id}`);
    return data;
  } catch (error) {
    console.error(`Error fetching contact ${id}:`, error.message);
    return null;
  }
}

function getPhoneFromContact(contact) {
  if (!contact || !contact.custom_fields_values) return null;
  
  const field = contact.custom_fields_values.find(
    x => Number(x.field_id) === Number(PHONE_FIELD_ID)
  );

  if (!field?.values?.length) {
    return null;
  }

  return field.values[0].value;
}

async function getPhoneFromLead(lead) {
  // Если контакты уже вложены в лид (при запросе с ?with=contacts)
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
      {
        id: Number(leadId),
        status_id: Number(statusId)
      }
    ]);
    console.log(`Lead ${leadId} moved to status ${statusId}`);
  } catch (error) {
    console.error(`Error moving lead ${leadId}:`, error.response?.data || error.message);
    throw error;
  }
}

async function deleteLead(leadId) {
  try {
    await api.delete(`/leads/${leadId}`);
    console.log(`Lead ${leadId} deleted`);
  } catch (error) {
    console.error(`Error deleting lead ${leadId}:`, error.response?.data || error.message);
    throw error;
  }
}

async function createTask(leadId, responsibleId, text) {
  try {
    await api.post("/tasks", [
      {
        text,
        entity_id: Number(leadId),
        entity_type: "leads",
        responsible_user_id: Number(responsibleId),
        complete_till: Math.floor(Date.now() / 1000) + 3600 // Через 1 час
      }
    ]);
    console.log(`Task created for lead ${leadId}`);
  } catch (error) {
    console.error(`Error creating task for lead ${leadId}:`, error.response?.data || error.message);
    // Не выбрасываем ошибку, чтобы не ломать основной поток, если задача не создалась
  }
}

async function findAllLeadsByPhone(phone) {
  const result = [];
  
  if (!phone) return result;

  try {
    // Ищем контакты по телефону
    const search = await api.get("/contacts", {
      params: {
        query: phone
      }
    });

    const contacts = search.data?._embedded?.contacts || [];

    for (const contact of contacts) {
      // Проверяем точное совпадение номера, так как поиск может быть неточным
      const contactPhone = normalizePhone(getPhoneFromContact(contact));
      if (contactPhone !== phone) {
        continue;
      }

      // Получаем лиды, привязанные к этому контакту
      const fullContact = await api.get(`/contacts/${contact.id}`, {
        params: {
          with: "leads"
        }
      });

      const leads = fullContact.data?._embedded?.leads || [];

      for (const lead of leads) {
        try {
          // Загружаем полную информацию о лиде
          const fullLead = await getLead(lead.id);
          result.push(fullLead);
        } catch (e) {
          console.error("Lead load error:", lead.id, e.message);
        }
      }
    }
  } catch (error) {
    console.error("Error in findAllLeadsByPhone:", error.message);
  }

  return result;
}

async function processLead(newLead) {
  console.log(`Processing lead: ${newLead.id}, Pipeline: ${newLead.pipeline_id}`);

  // Проверка воронки
  if (Number(newLead.pipeline_id) !== Number(PIPELINE_ID)) {
    console.log("Lead is not in target pipeline");
    return;
  }

  const phone = await getPhoneFromLead(newLead);
  if (!phone) {
    console.log("Phone not found in lead");
    return;
  }

  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    console.log("Invalid phone format");
    return;
  }

  console.log(`Searching for duplicates by phone: ${normalizedPhone}`);
  const allLeads = await findAllLeadsByPhone(normalizedPhone);

  const candidates = [];

  for (const lead of allLeads) {
    // Пропускаем текущий лид
    if (Number(lead.id) === Number(newLead.id)) {
      continue;
    }

    // Пропускаем лиды из другой воронки
    if (Number(lead.pipeline_id) !== Number(PIPELINE_ID)) {
      continue;
    }

    // Проверяем давность (30 дней)
    // newLead.created_at - это timestamp создания нового лида
    // lead.created_at - timestamp создания найденного старого лида
    // Мы ищем старые лиды, которые были созданы до нового, но не старше 30 дней
    
    const diffSeconds = Number(newLead.created_at) - Number(lead.created_at);
    const diffDays = diffSeconds / 86400;

    // Если старый лид создан позже нового (странная ситуация, но мало ли) или старше 30 дней
    if (diffDays < 0 || diffDays > 30) {
      continue;
    }

    candidates.push(lead);
  }

  if (!candidates.length) {
    console.log("No duplicate leads found in last 30 days");
    return;
  }

  // Сортируем по дате создания, чтобы найти самый старый
  candidates.sort((a, b) => Number(a.created_at) - Number(b.created_at));

  const oldestLead = candidates[0];
  console.log(`Oldest candidate lead: ${oldestLead.id}, Status: ${oldestLead.status_id}`);

  if (Number(oldestLead.status_id) === FAILED_STATUS_ID) {
    console.log("Oldest lead has FAILED status. Processing...");
    
    try {
      // Удаляем новый дубль
      await deleteLead(newLead.id);
      
      // Переводим старый лид в целевой статус
      await moveLead(oldestLead.id, TARGET_STATUS_ID);
      
      const taskText = "Повторное обращение клиента в течение 30 дней.";
      
      // Создаем задачи
      await createTask(oldestLead.id, oldestLead.responsible_user_id, taskText);
      if (RGP_USER_ID) {
        await createTask(oldestLead.id, Number(RGP_USER_ID), taskText);
      }
      
      console.log("Duplicate processed successfully (Failed case)");
    } catch (error) {
      console.error("Error processing failed duplicate:", error);
    }

  } else if (Number(oldestLead.status_id) === SUCCESS_STATUS_ID) {
    console.log("Oldest lead has SUCCESS status. Processing...");
    
    try {
      // Переводим новый лид в целевой статус
      await moveLead(newLead.id, TARGET_STATUS_ID);
      console.log("Duplicate processed successfully (Success case)");
    } catch (error) {
      console.error("Error processing success duplicate:", error);
    }
  } else {
    console.log(`Oldest lead status is ${oldestLead.status_id}. No action required.`);
  }
}

app.post("/webhook", async (req, res) => {
  // Важно ответить быстро, поэтому обработку делаем асинхронно без await в основном потоке, 
  // но для простоты оставим структуру, но уберем лишние задержки.
  
  try {
    const body = req.body;
    
    // Логируем тип события для отладки
    const eventType = Object.keys(body)[0]; // например 'leads', 'contacts'
    const eventAction = body[eventType] ? Object.keys(body[eventType])[0] : 'unknown'; // add, update, status
    
    console.log(`Webhook received: ${eventType}.${eventAction}`);

    // Извлекаем ID лида в зависимости от структуры
    let leadId = null;
    
    if (body.leads) {
      if (body.leads.add && body.leads.add.length > 0) {
        leadId = body.leads.add[0].id;
      } else if (body.leads.update && body.leads.update.length > 0) {
        leadId = body.leads.update[0].id;
      } else if (body.leads.status && body.leads.status.length > 0) {
        leadId = body.leads.status[0].id;
      }
    }

    if (!leadId) {
      console.log("No lead ID found in webhook");
      return res.sendStatus(200);
    }

    console.log(`Processing lead ID: ${leadId}`);

    // Небольшая задержка, чтобы данные успели сохраниться в БД amoCRM
    // 1-2 секунды обычно достаточно, 5 секунд многовато
    await new Promise(resolve => setTimeout(resolve, 1500));

    const newLead = await getLead(leadId);

    if (!newLead) {
      console.log("Lead not found after delay");
      return res.sendStatus(200);
    }

    await processLead(newLead);

    return res.sendStatus(200);

  } catch (e) {
    console.error("Webhook handler error:", e.response?.data || e.message);
    // Все равно возвращаем 200, чтобы amoCRM не повторял запрос бесконечно
    return res.sendStatus(200);
  }
});

app.get("/", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
