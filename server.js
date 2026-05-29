const express = require('express')
const axios = require('axios')

const app = express()

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// amoCRM API
const amoApi = axios.create({
  baseURL: `https://${process.env.AMO_SUBDOMAIN}.amocrm.ru/api/v4`,
  headers: {
    Authorization: `Bearer ${process.env.AMO_ACCESS_TOKEN}`,
    'Content-Type': 'application/json'
  }
})

// RO App API
const roappApi = axios.create({
  baseURL: 'https://api.roapp.io/v2',
  headers: {
    Authorization: `Bearer ${process.env.ROAPP_API_KEY}`,
    'Content-Type': 'application/json'
  }
})

// Проверка сервера
app.get('/', (req, res) => {
  res.send('Integration works')
})

// Webhook amoCRM
app.post('/webhook/amocrm', async (req, res) => {
  try {
    console.log('Webhook received')

    const leads = req.body.leads?.status

    if (!leads || !leads.length) {
      return res.sendStatus(200)
    }

    for (const item of leads) {
      const leadId = item.id
      const pipelineId = item.pipeline_id
      const statusId = item.status_id

      console.log('Lead ID:', leadId)

      // Проверка pipeline
      if (
        Number(pipelineId) !== Number(process.env.TARGET_PIPELINE_ID)
      ) {
        continue
      }

      // Проверка статуса
      if (
        Number(statusId) !== Number(process.env.TARGET_STATUS_ID)
      ) {
        continue
      }

      // Получаем сделку
      const leadResponse = await amoApi.get(`/leads/${leadId}`)

      const lead = leadResponse.data

      // Проверяем — не создан ли уже заказ
      let orderExists = false

      if (lead.custom_fields_values) {
        const field = lead.custom_fields_values.find(
          f =>
            f.field_id === Number(process.env.AMO_ROAPP_FIELD_ID)
        )

        if (
          field &&
          field.values &&
          field.values[0] &&
          field.values[0].value
        ) {
          orderExists = true
        }
      }

      if (orderExists) {
        console.log('Order already exists')

        continue
      }

      // Создаем заказ в RO App
      const orderPayload = {
        branch_id: Number(process.env.ROAPP_BRANCH_ID),

        order_type_id: Number(
          process.env.ROAPP_ORDER_TYPE_ID
        ),

        comment: `amoCRM lead #${lead.id}`,

        client: {
          name: lead.name
        }
      }

      const orderResponse = await roappApi.post(
        '/orders',
        orderPayload
      )

      const order = orderResponse.data

      console.log('RO App order created')

      const orderNumber =
        order.number ||
        order.id ||
        'UNKNOWN'

      // Обновляем сделку amoCRM
      await amoApi.patch(`/leads/${leadId}`, {
        custom_fields_values: [
          {
            field_id: Number(
              process.env.AMO_ROAPP_FIELD_ID
            ),
            values: [
              {
                value: String(orderNumber)
              }
            ]
          }
        ]
      })

      console.log('Lead updated')
    }

    res.sendStatus(200)
  } catch (error) {
    console.error(
      error.response?.data || error.message
    )

    res.sendStatus(500)
  }
})

const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`)
})
