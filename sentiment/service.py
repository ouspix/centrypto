import logging
import time
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from transformers import pipeline, AutoTokenizer, AutoModelForSeq2SeqLM
from langdetect import detect, LangDetectException

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = FastAPI(title="Centrypto Sentiment Service")

# --- Model Loading ---
logger.info("⏳ Loading models... This may take a while on first run.")

# 1. News Model: FinBERT-Crypto
try:
    news_pipeline = pipeline(
        "text-classification",
        model="burakutf/finetuned-finbert-crypto",
        tokenizer="burakutf/finetuned-finbert-crypto",
        return_all_scores=True
    )
    logger.info("✅ News model loaded: burakutf/finetuned-finbert-crypto")
except Exception as e:
    logger.error(f"❌ Failed to load News model: {e}")
    news_pipeline = None

# 2. Social Model: FinTwitBERT
try:
    social_pipeline = pipeline(
        "sentiment-analysis",
        model="StephanAkkerman/FinTwitBERT-sentiment",
        return_all_scores=True
    )
    logger.info("✅ Social model loaded: StephanAkkerman/FinTwitBERT-sentiment")
except Exception as e:
    logger.error(f"❌ Failed to load Social model: {e}")
    social_pipeline = None

# 3. Translator: Chinese -> English
try:
    zh_en_tokenizer = AutoTokenizer.from_pretrained("Helsinki-NLP/opus-mt-zh-en")
    zh_en_model = AutoModelForSeq2SeqLM.from_pretrained("Helsinki-NLP/opus-mt-zh-en")
    logger.info("✅ Translator loaded: Helsinki-NLP/opus-mt-zh-en")
except Exception as e:
    logger.error(f"❌ Failed to load Translator: {e}")
    zh_en_model = None

logger.info("🚀 Models ready!")

# --- Schemas ---
class ScoreRequest(BaseModel):
    text: str
    source: str = "unknown"

class ScoreResponse(BaseModel):
    score: float
    confidence: float
    label: str
    language: str
    translated_text: str | None = None

# --- Helper Functions ---
def translate_zh_to_en(text: str) -> str:
    if not zh_en_model or not zh_en_tokenizer:
        return text
    try:
        batch = zh_en_tokenizer(text, return_tensors="pt", truncation=True, max_length=512)
        gen = zh_en_model.generate(**batch, max_new_tokens=256)
        return zh_en_tokenizer.decode(gen[0], skip_special_tokens=True)
    except Exception as e:
        logger.error(f"Translation failed: {e}")
        return text

def normalize_score(label: str, score: float, model_type: str) -> float:
    """
    Normalize model outputs to a -1 to 1 scale.
    """
    if model_type == "news":
        # FinBERT-crypto labels: "Positive", "Negative", "Neutral" (check exact output)
        # Usually: Label_0, Label_1, etc. or specific strings.
        # burakutf/finetuned-finbert-crypto output seems to be:
        # [{'label': 'Neutral', 'score': ...}, {'label': 'Positive', 'score': ...}, {'label': 'Negative', 'score': ...}]
        
        if label.lower() == "positive":
            return score
        elif label.lower() == "negative":
            return -score
        else: # Neutral
            return 0.0

    elif model_type == "social":
        # FinTwitBERT labels: "Bullish", "Bearish", "Neutral"
        if label.lower() == "bullish":
            return score
        elif label.lower() == "bearish":
            return -score
        else: # Neutral
            return 0.0
            
    return 0.0

# --- Endpoints ---
@app.post("/score", response_model=ScoreResponse)
async def score_text(request: ScoreRequest):
    start_time = time.time()
    text = request.text
    original_text = text
    translated_text = None
    
    # 1. Language Detection
    try:
        lang = detect(text)
    except LangDetectException:
        lang = "en" # Fallback

    # 2. Translation (if Chinese)
    if lang.startswith("zh"):
        text = translate_zh_to_en(text)
        translated_text = text
        logger.info(f"Translated (zh->en): {original_text[:20]}... -> {text[:20]}...")

    # 3. Routing & Scoring
    model_type = "social"
    # Simple heuristic for news sources
    if any(s in request.source.lower() for s in ['news', 'coin', 'bloomberg', 'feed']):
        if not any(s in request.source.lower() for s in ['twitter', 'reddit', 'telegram']):
             model_type = "news"

    result = None
    
    if model_type == "news" and news_pipeline:
        # returns list of dicts with scores
        raw_results = news_pipeline(text)[0] # type: ignore
        # Find max score
        top_result = max(raw_results, key=lambda x: x['score'])
        result = {
            "label": top_result['label'],
            "score": top_result['score']
        }
    elif social_pipeline:
        # returns list of dicts
        raw_results = social_pipeline(text)[0] # type: ignore
        top_result = max(raw_results, key=lambda x: x['score'])
        result = {
            "label": top_result['label'],
            "score": top_result['score']
        }
    else:
        raise HTTPException(status_code=503, detail="Models not loaded")

    # 4. Normalization
    final_score = normalize_score(result['label'], result['score'], model_type)
    
    duration = (time.time() - start_time) * 1000
    logger.info(f"Scored '{text[:30]}...' ({model_type}) -> {final_score:.2f} ({duration:.0f}ms)")

    return ScoreResponse(
        score=final_score,
        confidence=result['score'],
        label=result['label'],
        language=lang,
        translated_text=translated_text
    )

@app.get("/health")
def health_check():
    return {"status": "ok", "models_loaded": news_pipeline is not None and social_pipeline is not None}
