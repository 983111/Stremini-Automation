/**
 * Stremini Security Scanner
 */

const WORKER = 'https://automation-agent.vishwajeetadkine705.workers.dev';

const PHISHING_PATTERNS = [
  /paypa[l1]\.(?!com\b)/i, /[a@]mazon\.(?!com\b|co\.uk\b)/i,
  /micros[o0]ft\.(?!com\b)/i, /app[l1]e\.(?!com\b)/i,
  /\bverify.{0,20}account\b/i, /\b(urgent|suspended|verify)\b.{0,40}\bclick\b/i,
  /win.{0,20}(prize|lottery|gift card)/i, /\baccount.{0,20}(suspend|terminat)/i,
];

const SCAM_KEYWORDS = [
  'congratulations you have been selected','click here to claim','act now or lose',
  'your account has been suspended','verify your identity immediately','unusual activity detected',
  'your payment failed','gift card payment','send bitcoin','irs tax warrant',
  'social security suspended','your computer is infected','call microsoft',
];

const BAD_TLDS   = ['.xyz','.top','.club','.online','.site','.bid','.loan','.win','.gq','.ml','.cf','.ga','.tk'];
const SHORTENERS = ['bit.ly','tinyurl','t.co','goo.gl','ow.ly','rb.gy','is.gd','cutt.ly'];

async function scanContent(content, scanType) {
  const findings = [];
  let score = 0;
  const lc = content.toLowerCase();

  // Phishing patterns
  for (const p of PHISHING_PATTERNS) {
    if (p.test(content)) { findings.push({ severity:'HIGH', category:'Brand Impersonation', detail:'Content impersonates a known brand' }); score += 35; }
  }

  // Scam keywords
  const kw = SCAM_KEYWORDS.filter(k => lc.includes(k));
  if (kw.length) { findings.push({ severity: kw.length >= 3 ? 'HIGH' : 'MEDIUM', category:'Scam Language', detail:`Contains: "${kw.slice(0,2).join('", "')}"` }); score += kw.length * 12; }

  // URLs
  const urls = (content.match(/https?:\/\/[^\s<>"']+|(?:www\.)[^\s<>"']+/gi) || []);
  for (const url of urls) {
    try {
      const h = new URL(url.startsWith('http') ? url : 'https://' + url).hostname.toLowerCase();
      if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) { findings.push({ severity:'HIGH', category:'IP Address URL', detail:`Uses raw IP: ${h}` }); score += 30; }
      if (SHORTENERS.some(s => h.includes(s))) { findings.push({ severity:'MEDIUM', category:'Shortened URL', detail:`Hides destination: ${h}` }); score += 18; }
      const tld = '.' + h.split('.').pop();
      if (BAD_TLDS.includes(tld)) { findings.push({ severity:'MEDIUM', category:'Suspicious TLD', detail:`High-risk TLD: ${tld}` }); score += 15; }
      for (const brand of ['paypal','amazon','google','microsoft','apple','netflix']) {
        if (h.includes(brand) && !h.endsWith(brand + '.com')) { findings.push({ severity:'HIGH', category:'Fake Domain', detail:`"${brand}" in non-official domain` }); score += 35; }
      }
      if (url.includes('@')) { findings.push({ severity:'HIGH', category:'URL Deception', detail:'@ symbol in URL — redirect trick' }); score += 30; }
    } catch (_) {}
  }

  // Urgency
  const urgency = ['urgent','immediately','expire','limited time','act now','final notice'].filter(w => lc.includes(w));
  if (urgency.length >= 2) { findings.push({ severity:'MEDIUM', category:'Pressure Tactics', detail:`"${urgency.slice(0,2).join('", "')}"` }); score += 15; }

  // Credential harvesting
  if (/\b(password|pin|otp|cvv|ssn|credit card number)\b/i.test(content)) { findings.push({ severity:'HIGH', category:'Credential Harvesting', detail:'Requests sensitive info' }); score += 40; }

  // Invoice fraud
  if (scanType === 'invoice' || /invoice|bank.{0,20}detail/i.test(content)) {
    if (/bank.{0,40}(changed|updated|new)/i.test(content)) { findings.push({ severity:'CRITICAL', category:'Invoice Fraud', detail:'🚨 Bank details changed — #1 invoice fraud tactic' }); score += 60; }
    if (/pay.{0,20}(today|immediately|now|urgent)/i.test(content)) { findings.push({ severity:'HIGH', category:'Payment Pressure', detail:'Unusual payment urgency' }); score += 20; }
  }

  score = Math.min(score, 100);
  const riskLevel = score >= 60 ? 'CRITICAL' : score >= 35 ? 'HIGH' : score >= 20 ? 'MEDIUM' : score >= 8 ? 'LOW' : 'SAFE';

  // AI analysis
  let aiAnalysis = null;
  try {
    const res = await fetch(WORKER, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'security', scan_type: scanType || 'phishing', query: content.slice(0, 2000) }),
    });
    const data = await res.json();
    aiAnalysis = data.content || null;
  } catch (_) {}

  const actions = {
    CRITICAL: '🚨 DO NOT interact. Do not click links or make payments. Report as phishing/scam.',
    HIGH:     '⛔ HIGH RISK — Do not click links or share personal info. Verify via official channels.',
    MEDIUM:   '⚠️ SUSPICIOUS — Verify the sender before acting.',
    LOW:      '⚡ Minor concerns. Review before proceeding.',
    SAFE:     '✅ No obvious threats. Stay cautious with unexpected messages.',
  };

  return { riskLevel, riskScore: score, findings, urls, aiAnalysis, recommendation: { action: actions[riskLevel] } };
}

module.exports = { scanContent };
