# pyre-ignore-all-errors
from fastapi import FastAPI, File, UploadFile, Form, Request
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse
import os, fitz, json, textwrap
from groq import Groq
from reportlab.pdfgen import canvas as pdf_canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from pypdf import PdfReader, PdfWriter
from typing import Optional
from datetime import datetime, timedelta

# API SETTINGS
from dotenv import load_dotenv
load_dotenv()

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
if not GROQ_API_KEY:
    print("WARNING: GROQ_API_KEY not found in .env file!")

client = Groq(api_key=GROQ_API_KEY)
app = FastAPI()
import aiofiles

# --- RATE LIMITING ---
DAILY_LIMIT = 10  # Max solve requests per IP per 24 hours
rate_limit_store = {}  # { ip: {"count": N, "reset_at": datetime} }

def check_rate_limit(ip: str) -> bool:
    """Returns True if the IP is allowed. False if the limit is exceeded."""
    now = datetime.utcnow()
    # Clean up expired entries
    expired = [k for k, v in rate_limit_store.items() if now > v["reset_at"]]
    for k in expired:
        del rate_limit_store[k]
    
    if ip not in rate_limit_store:
        rate_limit_store[ip] = {"count": 1, "reset_at": now + timedelta(hours=24)}
        return True
    
    entry = rate_limit_store[ip]
    if entry["count"] >= DAILY_LIMIT:
        return False  # Blocked!
    
    entry["count"] += 1
    return True

# Font Loading
try:
    pdfmetrics.registerFont(TTFont('ElYazisi', 'font.ttf'))
except:
    print("WARNING: font.ttf not found! Standard font (Helvetica) will be used.")

def solve_with_groq(question_text, general_context, custom_prompt=""):
    """
    Master Prompt: Core function that understands any question, resolves the context, and gives a flawless answer.
    """
    
    # 1. CORE ROLE AND BEHAVIOR (SYSTEM PROMPT)
    sys_msg = """You are a Universal Academic Expert, capable of flawlessly answering questions in ANY subject (History, Literature, Mathematics, Physics, Computer Science, etc.).
    Your sole purpose is to provide the absolute correct answer to the given problem.

    CORE RULES (NEVER VIOLATE THESE):
    1. ZERO CHATTER: Never say "Here is the answer", "Let's solve this", "Proof:", or "Answer:". 
       Just output the raw response directly.
    2. ADAPTIVE FORMATTING: 
       - Mathematics/Logic: Use standard mathematical notation.
       - Humanities/Science: Write raw facts or definitions.
    3. EXTREME BREVITY: MAX 2 SHORT LINES. Be extremely concise. The user relies on brevity. Do not use complex paragraphs.
    4. NO FILLER: Skip introductions ("Therefore", "The answer is..."). Start directly with the core facts.
    5. LANGUAGE: Respond in the language of the prompt or context.
    """

    # 2. CONTEXT AND QUESTION (USER PROMPT)
    user_msg = f"""
    --- CONTEXT OF THE WORKSHEET (Understand the Subject) ---
    {general_context}
    ------------------------------------------------

    --- PROBLEM TO SOLVE ---
    {question_text}
    ------------------------
    """

    # 3. CUSTOM USER INSTRUCTION
    if custom_prompt:
        user_msg += f"""
        --- CRITICAL USER INSTRUCTION ---
        The user has provided a specific override command for this problem. You MUST follow this command above all else:
        "{custom_prompt}"
        ---------------------------------
        """
    else:
        user_msg += """
        Think step-by-step silently. Analyze the subject material, identify the core question, and output ONLY the final, polished answer ready to be written on the exam paper.
        """

    try:
        res = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {"role": "system", "content": sys_msg},
                {"role": "user", "content": user_msg}
            ],
            temperature=0.05, 
            max_tokens=80 # Extremely aggressive truncation for handwriting
        )
        ans = res.choices[0].message.content.strip()
        ans = ans.replace('\n', ' ').replace('\r', '').strip() # Prevent newline corruption in frontend Engine
        
        # Sometimes AI stubbornly adds unnecessary words, let's do a final cleanup.
        for word in ["Answer:", "Solution:", "Proof:", "Here is the formula:"]:
             if ans.startswith(word):
                 ans = ans.replace(word, "").strip()
                 
        return ans
        
    except Exception as e:
        return f"Error: API did not respond. ({str(e)})"

# The text-to-image synthesis now happens 100% natively in the Javascript Frontend 
# using the mathematically flawless Phase 7 Calligrapher Neural Network.
# Python no longer needs to query HuggingFace APIs.


@app.get("/")
async def get_index():
    with open("index.html", "r", encoding="utf-8") as f:
        return HTMLResponse(content=f.read())

@app.get("/script.js")
async def get_script():
    return FileResponse("script.js", media_type="application/javascript")

@app.get("/style.css")
async def get_style():
    return FileResponse("style.css", media_type="text/css")

@app.get("/headless_engine.js")
async def get_engine():
    return FileResponse("headless_engine.js", media_type="application/javascript")

@app.get("/d.bin")
async def get_model_weights():
    return FileResponse("d.bin", media_type="application/octet-stream")


@app.post("/solve/")
async def solve_box(request: Request, file: UploadFile = File(...), box: str = Form(...)):
    # --- RATE LIMIT CHECK ---
    client_ip = request.client.host
    if not check_rate_limit(client_ip):
        return JSONResponse(
            status_code=429,
            content={"error": "Daily limit reached. You can solve up to 10 problems per day. Please come back tomorrow!"}
        )
    # Get the request from the box
    data = json.loads(box)
    input_path = f"temp_{file.filename}"
    async with aiofiles.open(input_path, "wb") as f:
        await f.write(await file.read())
    
    doc = fitz.open(input_path)
    page = doc[data['page'] - 1]
    
    # Get the general rules (Context) at the top of the page (First 800 Characters)
    full_page = page.get_text("text")
    general_context = full_page[:800] 
    
    # Find the question right above or next to the box
    text_blocks = page.get_text("blocks")
    found_q = ""
    for b in text_blocks:
        bx0, by0, bx1, by1, text, bno, *rest = b
        if text.strip() and by1 <= data['y'] + 25: 
            found_q = text.strip()
            
    # Get it if the user entered a custom prompt
    custom_prompt = data.get('customPrompt', '')
    
    # Send to the AI engine (Master prompt kicks in here)
    ans = solve_with_groq(found_q, general_context, custom_prompt)
        
    doc.close()
    os.remove(input_path)
    
    # Send the answer back to the frontend as JSON
    return JSONResponse(content={"answer": ans})


@app.post("/finalize/")
async def finalize(file: UploadFile = File(...), results: str = Form(...)):
    import base64
    
    items = json.loads(results)
    input_path = f"fin_{file.filename}"
    async with aiofiles.open(input_path, "wb") as f:
        await f.write(await file.read())
    
    doc = fitz.open(input_path)
    
    for i, page in enumerate(doc):
        page_items = [x for x in items if x['page'] == i + 1]
        for item in page_items:
            # Browser generated Base64 PNG natively with Calligrapher
            if item.get('pngBase64') and item['pngBase64'].startswith('data:image/png;base64,'):
                img_data = base64.b64decode(item['pngBase64'].split(',')[1])
                
                # Coordinates (PyMuPDF origin is top-left, same as HTML canvas)
                x0 = float(item['x'])
                y0 = float(item['y'])
                img_w = float(max(50, item['w']))
                img_h = float(max(20, item['h']))
                x1 = x0 + img_w
                y1 = y0 + img_h
                rect = fitz.Rect(x0, y0, x1, y1)
                
                # Natively stamp the transparent image directly into the PDF RAM buffer
                page.insert_image(rect, stream=img_data, keep_proportion=True)
                
            else:
                # Fallback purely as text using PyMuPDF native API
                x0, y0 = float(item['x']), float(item['y'])
                font_size = 13
                rect = fitz.Rect(x0, y0, x0 + float(item['w']), y0 + float(item['h']))
                page.insert_textbox(rect, item['answer'], fontsize=font_size, color=(0.1, 0.1, 0.6))
                
    out = f"output_{file.filename}"
    doc.save(out)
    doc.close()
    os.remove(input_path)
    
    # Download the finished file to the user
    return FileResponse(out, filename="homework_solved.pdf")