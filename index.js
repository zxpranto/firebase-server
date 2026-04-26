const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const fetch = require("node-fetch");
const mongoose = require("mongoose");

const app = express();
app.use(bodyParser.json());

/*
========================================
🔥 FIREBASE INIT
========================================
*/
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

/*
========================================
🔥 MONGODB CONNECT
========================================
*/
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.log("❌ DB Error:", err));

/*
========================================
🔥 TOKEN MODEL
========================================
*/
const tokenSchema = new mongoose.Schema({
  token: { type: String, unique: true },
});

const Token = mongoose.model("Token", tokenSchema);

/*
========================================
📌 BASIC ROUTE
========================================
*/
app.get("/", (req, res) => {
  res.send("🚀 Server Running");
});

/*
========================================
🔥 SAVE TOKEN (FROM APP)
========================================
*/
app.post("/save-token", async (req, res) => {
  const token = req.body.token;

  if (!token) {
    return res.json({ success: false });
  }

  try {
    await Token.updateOne(
      { token: token },
      { token: token },
      { upsert: true }
    );

    console.log("✅ Token Saved:", token);

    res.json({ success: true });

  } catch (e) {
    console.log("❌ Save Error:", e);
    res.json({ success: false });
  }
});

/*
========================================
🔔 SEND NOTIFICATION
========================================
*/
async function sendNotification(title, body) {
  try {
    const allTokens = await Token.find();
    const tokens = allTokens.map(t => t.token);

    if (tokens.length === 0) {
      console.log("❌ No tokens in DB");
      return;
    }

    const message = {
      notification: {
        title,
        body,
      },
      tokens,
    };

    const response = await admin.messaging().sendEachForMulticast(message);

    console.log("🔔 Sent:", response.successCount);

    // 🔥 INVALID TOKEN FIND
    const invalidTokens = [];

    response.responses.forEach((resp, index) => {
      if (!resp.success) {
        const errorCode = resp.error?.code;

        if (
          errorCode === "messaging/invalid-registration-token" ||
          errorCode === "messaging/registration-token-not-registered"
        ) {
          invalidTokens.push(tokens[index]);
        }
      }
    });

    // 🔥 DELETE FROM DB
    if (invalidTokens.length > 0) {
      await Token.deleteMany({ token: { $in: invalidTokens } });
      console.log("🧹 Removed invalid tokens:", invalidTokens.length);
    }

  } catch (error) {
    console.log("❌ Notification Error:", error);
  }
}
/*
========================================
🧪 TEST NOTIFICATION
========================================
*/
app.get("/test-notification", async (req, res) => {
  await sendNotification("Test 🔥", "Notification Working!");
  res.send("Notification Sent");
});

app.post("/new-order", async (req, res) => {
  const order = req.body;

  console.log("🆕 New Order:", order.id);

  await sendNotification(
    "🛒 New Order!",
    `Order #${order.id} received`
  );

  res.sendStatus(200);
});

/*
========================================
🔥 PATHAO CONFIG
========================================
*/
const CONFIG = {
  client_id: "xkazvgYaJ0",
  client_secret: "rjzQBdDTxUVi7U1PXB1gdBePwFb4wU9QJ3O7jHtn",
  username: "aysha.ahmed7787@gmail.com",
  password: "L%4!dHcGN6.ncT9",
  store_id: 217588,

  wo_url: "https://ayshacart.com",
  consumer_key: "ck_b31b6671958c555546caf0a43598d19f9785eafd",
  consumer_secret: "cs_550a31c9fa47dc7b284094a8a89c7f22e3c17d95",

  city_id: 1,
  zone_id: 1,
};

let pathaoToken = "";

/*
========================================
🔐 LOGIN PATHAO
========================================
*/
async function loginPathao() {
  try {
    const res = await fetch(
      "https://api-hermes.pathao.com/aladdin/api/v1/issue-token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: CONFIG.client_id,
          client_secret: CONFIG.client_secret,
          grant_type: "password",
          username: CONFIG.username,
          password: CONFIG.password,
        }),
      }
    );

    const data = await res.json();

    if (data.access_token) {
      pathaoToken = data.access_token;
      console.log("✅ Pathao Token Ready");
    } else {
      console.log("❌ Token Error:", data);
    }
  } catch (err) {
    console.log("❌ LOGIN ERROR:", err);
  }
}

// 🔁 refresh token
setInterval(loginPathao, 50 * 60 * 1000);

/*
========================================
📦 CREATE PATHAO ORDER
========================================
*/
app.post("/create-pathao", async (req, res) => {
  const orderId = req.body.order_id;

  try {
    if (!pathaoToken) {
      await loginPathao();
    }

    const woRes = await fetch(
      `${CONFIG.wo_url}/wp-json/wc/v3/orders/${orderId}?consumer_key=${CONFIG.consumer_key}&consumer_secret=${CONFIG.consumer_secret}`
    );

    const order = await woRes.json();

    if (!order || !order.id) {
      return res.json({ success: false, message: "Order not found" });
    }

    let amount = order.payment_method === "cod"
      ? parseFloat(order.total)
      : 0;

    const pRes = await fetch(
      "https://api-hermes.pathao.com/aladdin/api/v1/orders",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${pathaoToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          store_id: CONFIG.store_id,
          merchant_order_id: order.id.toString(),
          recipient_name: order.billing.first_name,
          recipient_phone: order.billing.phone,
          recipient_address: order.billing.address_1,
          recipient_city: CONFIG.city_id,
          recipient_zone: CONFIG.zone_id,
          delivery_type: 48,
          item_type: 2,
          item_quantity: 1,
          item_weight: 0.5,
          amount_to_collect: amount,
        }),
      }
    );

    const result = await pRes.json();

    console.log("🚚 Pathao Response:", result);

    if (result && result.data) {

      await sendNotification(
        "New Order 🚚",
        `Order #${order.id} sent to Pathao`
      );

      return res.json({ success: true });
    }

    return res.json({
      success: false,
      message: result.message || "Pathao failed",
    });

  } catch (e) {
    console.log("❌ SERVER ERROR:", e);

    return res.json({
      success: false,
      message: "Server error",
    });
  }
});

/*
========================================
🚀 START SERVER
========================================
*/
app.listen(3000, async () => {
  console.log("🚀 Server Started");
  await loginPathao();
});
