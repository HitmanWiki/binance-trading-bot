const axios = require("axios");
const crypto = require("crypto");
require("dotenv").config();

const BASE_URL = "https://testnet.binancefuture.com";
const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;

// Configuration
const LEVERAGE = 10;
const RISK_PER_TRADE = 0.01;
const MAX_LOT_SIZE = 0.01;
const DAILY_RISK_CAP = 0.05;
const SYMBOL = "BTCUSDT";
const INTERVAL = "3m";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let serverTimeOffset = 0;
let dailyLoss = 0;
let assetPrecision = 3; // Default to 3 decimal places if precision is not fetched

// Helper Functions
function signRequest(params) {
  params.timestamp = Date.now() + serverTimeOffset;
  const query = new URLSearchParams(params).toString();
  const signature = crypto.createHmac("sha256", API_SECRET).update(query).digest("hex");
  return { ...params, signature };
}

async function binanceRequest(endpoint, method, params = {}) {
  const signedParams = signRequest(params);
  const headers = { "X-MBX-APIKEY": API_KEY };

  try {
    const response = await axios({
      method,
      url: `${BASE_URL}${endpoint}`,
      headers,
      params: signedParams,
    });
    return response.data;
  } catch (error) {
    console.error("API Request Error:", error.response ? error.response.data : error.message);
    await sendTelegramMessage(`API Error: ${error.message}`);
    throw error;
  }
}

async function sendTelegramMessage(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: message });
  } catch (error) {
    console.error("Failed to send Telegram message:", error.message);
  }
}
// Synchronize Server Time
async function synchronizeServerTime() {
  try {
    const response = await axios.get(`${BASE_URL}/fapi/v1/time`);
    const serverTime = response.data.serverTime;
    const localTime = Date.now();
    serverTimeOffset = serverTime - localTime;
    console.log(`Server time offset updated: ${serverTimeOffset}ms`);
  } catch (error) {
    console.error("Failed to synchronize server time:", error.message);
    await sendTelegramMessage(`Failed to synchronize server time: ${error.message}`);
    // Retry synchronization after 5 seconds
    setTimeout(() => synchronizeServerTime(), 5000);
  }
}
// Fetch Asset Precision
async function fetchAssetPrecision(symbol) {
  try {
    const response = await binanceRequest("/fapi/v1/exchangeInfo", "GET");
    const assetInfo = response.symbols.find((s) => s.symbol === symbol);
    if (assetInfo) {
      assetPrecision = assetInfo.quantityPrecision; // Dynamically set precision
      console.log(`Asset precision for ${symbol}: ${assetPrecision}`);
    } else {
      console.warn(`Asset ${symbol} not found in exchangeInfo.`);
    }
  } catch (error) {
    console.error("Failed to fetch asset precision:", error.message);
    await sendTelegramMessage(`Failed to fetch asset precision: ${error.message}`);
  }
}

// Fetch market data
async function fetchKlines(symbol, interval, limit = 100) {
  const params = { symbol, interval, limit };
  const data = await binanceRequest("/fapi/v1/klines", "GET", params);
  return data.map((candle) => ({
    close: parseFloat(candle[4]),
    high: parseFloat(candle[2]),
    low: parseFloat(candle[3]),
  }));
}

// Indicator Calculations
function calculateEMA(data, period) {
  const multiplier = 2 / (period + 1);
  return data.reduce((ema, price, index) => {
    if (index === 0) {
      ema.push(price);
    } else {
      ema.push((price - ema[ema.length - 1]) * multiplier + ema[ema.length - 1]);
    }
    return ema;
  }, []);
}

function calculateRSI(data, period) {
  let gains = 0,
    losses = 0;
  for (let i = 1; i < period; i++) {
    const change = data[i] - data[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calculateATR(data, period) {
  const tr = data.map((candle, i) => {
    if (i === 0) return 0;
    const highLow = candle.high - candle.low;
    const highClose = Math.abs(candle.high - data[i - 1].close);
    const lowClose = Math.abs(candle.low - data[i - 1].close);
    return Math.max(highLow, highClose, lowClose);
  });

  return tr.slice(period).reduce((acc, val) => acc + val, 0) / period;
}

function calculateSupportResistance(data) {
  const highs = data.map((candle) => candle.high);
  const lows = data.map((candle) => candle.low);

  const resistance = Math.max(...highs);
  const support = Math.min(...lows);

  return { resistance, support };
}

function calculateCPR(data) {
  const highs = data.map((candle) => candle.high);
  const lows = data.map((candle) => candle.low);
  const closes = data.map((candle) => candle.close);

  const pivotHigh = Math.max(...highs);
  const pivotLow = Math.min(...lows);
  const pivotClose = closes.reduce((sum, val) => sum + val, 0) / closes.length;

  const cprTop = (pivotHigh + pivotLow + pivotClose) / 3;
  const cprBottom = (pivotHigh + pivotLow) / 2;

  return { cprTop, cprBottom };
}

function calculateDynamicBollingerBands(data, atr) {
  const multiplier = 2 + atr / 1000; // Adjust multiplier dynamically
  const sma = data.reduce((a, b) => a + b, 0) / data.length;
  const variance = data.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / data.length;
  const stddev = Math.sqrt(variance);

  return {
    upper: sma + multiplier * stddev,
    lower: sma - multiplier * stddev,
  };
}

// Trailing Stop-Loss
function adjustTrailingStop(currentPrice, entryPrice, stopLoss, direction) {
  if (direction === "BUY" && currentPrice > entryPrice) {
    return Math.max(stopLoss, currentPrice - (currentPrice - entryPrice) * 0.5);
  } else if (direction === "SELL" && currentPrice < entryPrice) {
    return Math.min(stopLoss, currentPrice + (entryPrice - currentPrice) * 0.5);
  }
  return stopLoss;
}

// Place Order with Correct Precision
async function placeOrder(symbol, side, quantity) {
  const adjustedQuantity = parseFloat(quantity.toFixed(assetPrecision || 3)); // Adjust to allowed precision
  const params = {
    symbol,
    side,
    type: "MARKET",
    quantity: adjustedQuantity,
    timestamp: Date.now() + serverTimeOffset,
  };

  try {
    const response = await binanceRequest("/fapi/v1/order", "POST", params);
    console.log(`${side} Order Placed:`, response);
    await sendTelegramMessage(`${side} Order Placed:\nQuantity: ${adjustedQuantity}`);
    return response;
  } catch (error) {
    console.error("Failed to place order:", error.message);
    await sendTelegramMessage(`Failed to place order: ${error.message}`);
  }
}

// Evaluate and Execute Trades



async function evaluateStrategy() {
  try {
    assetPrecision = await getAssetPrecision(SYMBOL); // Dynamically fetch precision, if applicable

    const data = await fetchKlines(SYMBOL, INTERVAL, 100);




    const closes = data.map((candle) => candle.close);
    const atr = calculateATR(data, 14);
    const emaShort = calculateEMA(closes, 9).pop();
    const emaLong = calculateEMA(closes, 21).pop();
    const rsi = calculateRSI(closes, 14);
    const { resistance, support } = calculateSupportResistance(data);
    const { cprTop, cprBottom } = calculateCPR(data);
    const { upper: bbUpper, lower: bbLower } = calculateDynamicBollingerBands(closes, atr);
    const currentPrice = closes[closes.length - 1];

    const riskAmount = 200 * RISK_PER_TRADE;
    if (atr > 10000) {
      riskAmount = Math.max(riskAmount, 20); // Dynamically increase risk amount for high ATR
    }
    const rawPositionSize = riskAmount / atr; // Position size based on risk and ATR
    const positionSize = Math.max(rawPositionSize, 0.001).toFixed(assetPrecision || 3);
    // Enforce minimum lot size

    let stopLoss = currentPrice - atr * 1.5; // Use let because stopLoss might be reassigned
    stopLoss = support || currentPrice - atr * 1.5; // Reassign based on support level
    let takeProfit = currentPrice + atr * 2; // Use let for reassignment
    takeProfit = resistance || currentPrice + atr * 2; // Reassign based on resistance level

    // Calculate risk-to-reward ratio
    const riskToReward = (takeProfit - currentPrice) / (currentPrice - stopLoss);


    // Log debug information
    console.log(`ATR: ${atr}, Risk Amount: ${riskAmount}, Raw Position Size: ${rawPositionSize}, Final Position Size: ${positionSize}`);


  } catch (error) {
    // Handle errors here
    console.error("Error in evaluateStrategy:", error.message);
    await sendTelegramMessage(`Error in evaluateStrategy: ${error.message}`);
  } finally {
    // Optional: Code to run after try/catch
    console.log("Strategy evaluation cycle complete.");
  }
}

// Validation for position size
if (parseFloat(positionSize) <= 0.001) {
  console.error("Calculated position size is invalid. Skipping trade.");
  // await sendTelegramMessage("Invalid position size. Trade skipped.");
  return;
}
const minRiskToReward = atr > 500 ? 1.5 : 2; // Example: Lower R:R for high volatility

if (riskToReward < minRiskToReward) {
  console.log(`Trade skipped: Risk-to-reward ratio (${riskToReward}) is below minimum (${minRiskToReward}).`);
  await sendTelegramMessage("Trade skipped: Risk-to-reward ratio too low.");
  return;
}
// Long Trade Logic
if (

  emaShort > emaLong &&
  rsi > 50 &&
  currentPrice > cprTop &&
  currentPrice > support
) {
  console.log("Long Signal Detected");
  stopLoss = adjustTrailingStop(currentPrice, currentPrice, stopLoss, "BUY");
  await placeOrder(SYMBOL, "BUY", positionSize, stopLoss, takeProfit);
}

// Short Trade Logic
else if (

  emaShort < emaLong &&
  rsi < 50 &&
  currentPrice < cprBottom &&
  currentPrice < resistance
) {
  console.log("Short Signal Detected");
  stopLoss = adjustTrailingStop(currentPrice, currentPrice, stopLoss, "SELL");
  await placeOrder(SYMBOL, "SELL", positionSize, stopLoss, takeProfit);
} else {
  console.log("No trade signal detected.");
}



//Function to dynamically fetch asset precision
async function getAssetPrecision(symbol) {
  const exchangeInfo = await binanceRequest("/fapi/v1/exchangeInfo", "GET");
  const symbolInfo = exchangeInfo.symbols.find((s) => s.symbol === symbol);
  if (!symbolInfo) {
    throw new Error(`Symbol ${symbol} not found in exchange info.`);
  }
  return symbolInfo.quantityPrecision;
}
// Main Bot Loop
(async () => {
  try {
    // Synchronize server time at startup
    await synchronizeServerTime();
    await fetchAssetPrecision(SYMBOL);

    // Repeat synchronization every hour
    setInterval(async () => {
      await synchronizeServerTime();
    }, 3600000); // 1 hour

    // Main bot loop
    while (true) {
      await evaluateStrategy();
      console.log("Waiting for the next 3-minute candle...");
      await new Promise((resolve) => setTimeout(resolve, 180000)); // Wait for 3 minutes
    }
  } catch (error) {
    console.error("Critical Error:", error.message);
    await sendTelegramMessage(`Critical Error: ${error.message}`);
  }
})();