// netlify/functions/analyze.js  (Google Gemini 버전)
// 브라우저 -> (이 함수) -> Google Gemini API
// API 키는 Netlify 환경변수 GEMINI_API_KEY 에만 저장되며 브라우저에는 노출되지 않습니다.

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// gemini-1.5-flash 는 이미 종료된 모델이라(404) 현재 무료 사용 가능한 최신 Flash 계열을 기본값으로 씁니다.
// 필요하면 Netlify 환경변수로 바꿀 수 있어요.
const PRIMARY_MODEL = (process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.5-flash-lite')
  .split(',').map((s) => s.trim()).filter(Boolean);
const THINKING_LEVEL = (process.env.GEMINI_THINKING_LEVEL || 'low').trim().toLowerCase(); // 'none' 이면 미사용

const MAX_FILES = 5;
const MAX_TOTAL_BASE64_CHARS = 4500000; // Netlify 요청 한도(6MB) 안전 마진
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

const TOTAL_BUDGET_MS = 55000;     // Netlify 동기 함수 제한(60초) 안쪽으로 유지
const PER_ATTEMPT_TIMEOUT_MS = 25000;

// 프롬프트는 서버에만 둡니다. (클라이언트가 임의 프롬프트를 보내 API를 악용하는 것을 방지)
const SYSTEM_PROMPT = `너는 10년 차 보건 전문가이자 대사증후군 상담 AI다. 직장인이 업로드한 건강검진 결과지(사진 또는 PDF, 한 건당 1~5장)를 분석한다. 여러 장이 함께 제공되면 같은 검진 결과지의 앞/뒤 페이지이거나 서로 다른 각도로 찍은 사진일 수 있으니, 모든 장을 함께 참고해서 하나의 결과로 종합 판단해라. 한 항목의 수치가 특정 장에만 보여도 놓치지 말고 반영해라.

[1단계: 개인정보 검사 - 최우선]
문서에 이름, 주민등록번호, 주소, 전화번호 등 개인을 특정할 수 있는 식별 정보가 그대로 보이면 절대 수치 분석을 진행하지 말고 privacy_issue를 true로 반환해라. (병원명·검진기관명은 개인정보가 아니므로 노출되어도 차단하지 말고 정상적으로 분석을 진행해라.)

[2단계: 수치 판독 - 개인정보가 없을 때만]
아래 기준으로 4개 카테고리의 등급을 A(정상A) / B(정상B, 경계) / C(질환의심) 중 하나로 판정해라.

- waist (복부비만): 정상A = 남 90cm 미만 / 여 85cm 미만. 질환의심(C) = 남 90cm 이상 / 여 85cm 이상. (경계 등급 없음, A 또는 C만 사용)
- bp (혈압): 정상A = 수축기 120미만 그리고 이완기 80미만. 정상B = 수축기 120-139 또는 이완기 80-89. 질환의심(C) = 수축기 140이상 또는 이완기 90이상.
- glucose (공복혈당): 정상A 100미만. 정상B 100-125. 질환의심(C) 126이상.
- lipid (이상지질혈증 - 중성지방/HDL 중 더 나쁜 쪽 등급을 최종 등급으로): 중성지방 정상A<150,정상B 150-199,질환의심 200이상. HDL콜레스테롤 정상A 60이상, 정상B 40-59, 질환의심 40미만.

[수치 미기재 처리 규칙 - 중요]
특정 항목의 수치란이 "비해당", "-", 공란이거나 실제 숫자가 기재되어 있지 않은 경우, 그 항목에 이상이 있다고 추정하지 말고 반드시 정상A로 판정해라. 단, 같은 항목에 대해 결과 체크박스(☑) 등으로 "질환의심"이나 "경계" 등 이상 소견이 명시적으로 체크되어 있다면 그 표시를 따르되, 아무 표시도 근거도 없다면 절대 임의로 정상B나 질환의심으로 추정하지 말아라. 불확실할 때는 항상 더 안전한 쪽(정상A)으로 판정해라.

[3단계: 항목별 코멘트 작성]
등급이 B 또는 C인 항목에 한해서만 아래 데이터베이스의 취지를 살려 description(1~2문장), diet(2~3문장, \\n으로 구분), exercise(2~3문장, \\n으로 구분), tip(혈압·혈당 항목에만 1~2문장, 없으면 빈 문자열)을 한국어로 작성해라. 표현은 자연스럽게 바꿔도 되지만 아래 내용의 실질적 조언은 반드시 반영해라.

▶ 높은 혈압: 침묵의 살인자로 뇌졸중·심근경색·신장질환을 유발할 수 있음을 설명. 식이는 저염식, 가공식품 대신 고등어·두부 등 담백한 단백질, 흰쌀밥 대신 잡곡밥. 운동은 주 3회 이상 빠르게 걷기·자전거·조깅·수영, 계단 오르기, 맨몸 스쿼트. tip은 측정 전 5~10분 휴식, 측정 전 30분 금연, 어지러움/가슴통증 시 즉시 중단하고 병원 내원.

▶ 공복혈당 상승: 인슐린 문제로 혈액 속 포도당이 쌓여 방치 시 뇌졸중·심근경색·실명·신장질환으로 이어질 수 있음을 설명. 식이는 채소→고기/생선→밥 순서의 거꾸로 식사법, 믹스커피 대신 블랙커피, 기상 후 삶은 계란·요거트·견과류 등 단백질 위주로 시작. 운동은 식후 20~30분 가벼운 산책, 주 3회 이상 빠르게 걷기·수영·자전거, 하체 근력 운동. tip은 저혈당 대비 간식 준비, 공복 운동 자제, 물 대신 마시는 차 종류 주의.

▶ 복부비만: 내장지방형 비만이 대사증후군의 가장 강력한 원인임을 설명. 식이는 규칙적 식사와 저녁 8시 이후 야식 금지, 정제 탄수화물(흰쌀밥·빵·라면) 대신 잡곡·현미·통밀·오트밀, 매 끼니 손바닥 크기의 단백질(닭가슴살·두부·달걀·생선), 음주 최소화. 운동은 3분 걷기-2분 빠르게 달리기를 반복하는 인터벌 러닝 주 3회 이상, 주 2회 이상 스쿼트 등 큰 근육 위주 근력운동.

▶ 이상지질혈증(중성지방/HDL): 혈액 속 기름기가 많아 혈관을 막고 뇌졸중·심근경색·당뇨병·급성췌장염으로 이어질 수 있음을 설명. 식이는 트랜스지방(튀김·인스턴트)과 야식 절제, 밥·빵·면 대신 식이섬유 풍부한 잡곡·해조류·쌈채소, 콩/두유/두부 등 식물성 단백질, 절주, 오메가3 풍부한 등푸른생선과 견과류 섭취. 운동은 주 3회 이상 유산소(빠르게 걷기·자전거·수영·댄스), 주 2회 이상 근력운동(맨몸 스쿼트·계단오르기).

[출력 형식]
설명이나 코드블록 없이 아래 JSON만 정확히 출력해라:
{
  "privacy_issue": boolean,
  "categories": [
    {"id":"waist","name":"복부비만","status":"A|C","reading":"허리둘레 00cm 등 짧은 수치 요약","description":"","diet":"","exercise":"","tip":""},
    {"id":"bp","name":"높은 혈압","status":"A|B|C","reading":"","description":"","diet":"","exercise":"","tip":""},
    {"id":"glucose","name":"공복혈당 상승","status":"A|B|C","reading":"","description":"","diet":"","exercise":"","tip":""},
    {"id":"lipid","name":"이상지질혈증","status":"A|B|C","reading":"","description":"","diet":"","exercise":"","tip":""}
  ]
}
status가 A인 항목은 description/diet/exercise/tip을 빈 문자열로 두어라. privacy_issue가 true면 categories는 빈 배열로 반환해라.`;

const CATEGORY_DEFS = [
  { id: 'waist', name: '복부비만', allowed: ['A', 'C'] },
  { id: 'bp', name: '높은 혈압', allowed: ['A', 'B', 'C'] },
  { id: 'glucose', name: '공복혈당 상승', allowed: ['A', 'B', 'C'] },
  { id: 'lipid', name: '이상지질혈증', allowed: ['A', 'B', 'C'] }
];

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj)
});

// ---------- Gemini 호출 ----------
async function callGemini(model, apiKey, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function describeError(status, data) {
  const raw = (data && data.error && data.error.message) || '';
  if (/api key/i.test(raw) || status === 401 || status === 403) {
    return { fatal: true, status: 500, message: '서버의 GEMINI_API_KEY가 올바르지 않거나 권한이 없어요. Netlify 환경변수를 확인해 주세요.' };
  }
  if (status === 429) {
    return { fatal: false, status: 429, message: '무료 사용 한도에 도달했어요. 잠시 후 다시 시도해 주세요.' };
  }
  if (status === 404) {
    return { fatal: false, status: 502, message: '설정된 Gemini 모델을 찾을 수 없어요. GEMINI_MODEL 환경변수를 확인해 주세요.' };
  }
  if (status === 500 || status === 503) {
    return { fatal: false, status: 503, message: 'AI 서버가 혼잡해요. 잠시 후 다시 시도해 주세요.' };
  }
  return { fatal: false, status: 502, message: raw || `Gemini API 오류 (HTTP ${status})` };
}

// ---------- 응답 해석 ----------
function extractText(data) {
  const block = data && data.promptFeedback && data.promptFeedback.blockReason;
  if (block) return { error: `안전 필터에 의해 요청이 차단되었어요 (${block}). 다른 사진으로 시도해 주세요.` };

  const cand = data && data.candidates && data.candidates[0];
  if (!cand) return { error: 'AI 응답이 비어 있어요. 다시 시도해 주세요.' };

  const parts = (cand.content && cand.content.parts) || [];
  const text = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
  if (!text.trim()) {
    return { error: `AI가 결과를 만들지 못했어요${cand.finishReason ? ` (${cand.finishReason})` : ''}. 다시 시도해 주세요.` };
  }
  return { text, finishReason: cand.finishReason };
}

function parseJson(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch (e) {
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch (_) { /* fallthrough */ }
    }
    return null;
  }
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

// 프론트가 기대하는 규격 { privacy_issue, categories:[{id,name,status,reading,description,diet,exercise,tip}] } 로 정리
function normalize(obj) {
  if (!obj || typeof obj !== 'object') return { error: 'AI 응답 형식이 올바르지 않아요.' };
  if (obj.privacy_issue === true) return { value: { privacy_issue: true, categories: [] } };

  const byId = {};
  (Array.isArray(obj.categories) ? obj.categories : []).forEach((c) => {
    if (c && typeof c.id === 'string') byId[c.id.trim().toLowerCase()] = c;
  });

  const categories = [];
  for (const def of CATEGORY_DEFS) {
    const c = byId[def.id];
    // 판독 결과가 빠졌는데 "정상"으로 채우면 잘못된 안내가 되므로 실패 처리해서 재시도하게 합니다.
    if (!c) return { error: 'AI가 일부 항목을 판독하지 못했어요. 다시 시도해 주세요.' };

    let status = str(c.status).trim().toUpperCase();
    if (!['A', 'B', 'C'].includes(status)) status = 'A';
    if (!def.allowed.includes(status)) status = 'A'; // 복부비만은 경계(B) 등급이 없음

    const isNormal = status === 'A';
    categories.push({
      id: def.id,
      name: def.name,
      status,
      reading: str(c.reading),
      description: isNormal ? '' : str(c.description),
      diet: isNormal ? '' : str(c.diet),
      exercise: isNormal ? '' : str(c.exercise),
      tip: isNormal ? '' : str(c.tip)
    });
  }
  return { value: { privacy_issue: false, categories } };
}

// ---------- 핸들러 ----------
exports.handler = async (event) => {
  const startedAt = Date.now();

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'POST 요청만 지원합니다.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json(500, { error: '서버에 GEMINI_API_KEY 환경변수가 설정되지 않았습니다.' });
  }

  // ---- 입력 검증 ----
  let payload;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf-8') : event.body;
    payload = JSON.parse(raw || '{}');
  } catch (e) {
    return json(400, { error: '요청 형식이 올바르지 않습니다.' });
  }

  const files = payload.files;
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) {
    return json(400, { error: `파일은 1~${MAX_FILES}장까지 올릴 수 있습니다.` });
  }

  let totalChars = 0;
  const fileParts = [];
  for (const f of files) {
    if (!f || typeof f.data !== 'string' || f.data.length === 0) {
      return json(400, { error: '파일 데이터가 올바르지 않습니다.' });
    }
    totalChars += f.data.length;

    if (f.kind === 'pdf') {
      fileParts.push({ inlineData: { mimeType: 'application/pdf', data: f.data } });
    } else if (f.kind === 'image' && ALLOWED_IMAGE_TYPES.includes(f.mediaType)) {
      fileParts.push({ inlineData: { mimeType: f.mediaType, data: f.data } });
    } else {
      return json(400, { error: '지원하지 않는 파일 형식입니다. (JPG/PNG/PDF)' });
    }
  }
  if (totalChars > MAX_TOTAL_BASE64_CHARS) {
    return json(413, { error: '파일 용량이 너무 큽니다. 장수를 줄이거나 다시 촬영해 주세요.' });
  }

  const buildPayload = (withThinking) => ({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [
      {
        role: 'user',
        parts: [
          ...fileParts,
          { text: `이 건강검진 결과지(총 ${fileParts.length}장)를 모두 참고해서 분석하고 JSON으로만 답변해줘.` }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      maxOutputTokens: 8192,
      ...(withThinking && THINKING_LEVEL !== 'none' ? { thinkingConfig: { thinkingLevel: THINKING_LEVEL } } : {})
    }
  });

  // ---- 기본 모델 -> 실패 시 예비 모델 순서로 시도 (무료 한도/일시 장애 대비) ----
  const models = [PRIMARY_MODEL, ...FALLBACK_MODELS.filter((m) => m !== PRIMARY_MODEL)];
  let lastError = { status: 502, message: 'AI 서버와 통신하지 못했어요. 잠시 후 다시 시도해 주세요.' };

  for (const model of models) {
    const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
    if (remaining < 8000) break;
    const timeoutMs = Math.min(PER_ATTEMPT_TIMEOUT_MS, remaining - 2000);

    try {
      let r = await callGemini(model, apiKey, buildPayload(true), timeoutMs);

      // thinking 옵션을 받지 않는 모델이면 옵션 없이 한 번 더
      if (!r.ok && r.status === 400 && THINKING_LEVEL !== 'none' && /think/i.test(JSON.stringify(r.data || {}))) {
        r = await callGemini(model, apiKey, buildPayload(false), Math.max(5000, timeoutMs - 2000));
      }

      if (!r.ok) {
        const info = describeError(r.status, r.data);
        console.error(`Gemini error model=${model} status=${r.status}`, (r.data && r.data.error && r.data.error.message) || '');
        if (info.fatal) return json(info.status, { error: info.message });
        lastError = info;
        continue;
      }

      const ex = extractText(r.data);
      if (ex.error) { lastError = { status: 502, message: ex.error }; continue; }

      const parsed = parseJson(ex.text);
      if (!parsed) {
        lastError = {
          status: 502,
          message: ex.finishReason === 'MAX_TOKENS'
            ? 'AI 응답이 길어서 중간에 끊겼어요. 다시 시도해 주세요.'
            : 'AI 응답 형식이 올바르지 않아요. 다시 시도해 주세요.'
        };
        continue;
      }

      const norm = normalize(parsed);
      if (norm.error) { lastError = { status: 502, message: norm.error }; continue; }

      return json(200, { text: JSON.stringify(norm.value), model });
    } catch (err) {
      const timedOut = err && err.name === 'AbortError';
      console.error(`Function error model=${model}`, timedOut ? 'timeout' : (err && err.message));
      lastError = {
        status: timedOut ? 504 : 502,
        message: timedOut ? 'AI 응답이 지연되고 있어요. 잠시 후 다시 시도해 주세요.' : 'AI 서버와 통신하지 못했어요. 잠시 후 다시 시도해 주세요.'
      };
    }
  }

  return json(lastError.status, { error: lastError.message });
};
