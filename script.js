pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';

// --- PHANTOM BRIDGE: Commandeers the legacy minified engine ---
window.initCalligrapher = function(style, bias) {
    document.getElementById('select-style').value = style;
    document.getElementById('bias-slider').value = bias;
};
window.generate_text = function(text) {
    document.getElementById('text-input').value = text;
    // Simulate a user click to trigger the minified script's 'E()' function
    document.getElementById('draw-button').dispatchEvent(new MouseEvent('mousedown'));
};
window.get_svg_path = function() {
    const canvas = document.getElementById('canvas');
    if (canvas.lastElementChild && canvas.lastElementChild.tagName.toLowerCase() === 'path') {
        const d = canvas.lastElementChild.getAttribute('d');
        canvas.innerHTML = ''; // Wipe canvas clean for the next text chunk
        return d;
    }
    return null;
};
// --------------------------------------------------------------

let pdfDoc = null, pageNum = 1, scale = 1.3, viewport = null;
let boxes = [], isDrawing = false, startX, startY;
let activeBoxId = null; // Holds the currently selected box ID

const canvas = document.getElementById('pdfCanvas'), ctx = canvas.getContext('2d');
const cont = document.getElementById('container'), sel = document.getElementById('selection');
const toolbar = document.getElementById('box-toolbar');

function calculateScale(page) {
    // Calculate optimal scale based on window width (leave some margin)
    const margin = 100; // 50px each side
    const availableWidth = window.innerWidth - margin;
    const defaultViewport = page.getViewport({ scale: 1.0 });
    let newScale = availableWidth / defaultViewport.width;

    // Don't upscale too much or downscale too tiny
    if (newScale > 1.8) newScale = 1.8;
    if (newScale < 0.6) newScale = 0.6;

    return newScale;
}

document.getElementById('pdfIn').onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
        pdfjsLib.getDocument(new Uint8Array(this.result)).promise.then(pdf => {
            pdfDoc = pdf; cont.classList.remove('hidden');
            document.getElementById('controls').classList.remove('hidden');
            render();
        });
    };
    reader.readAsArrayBuffer(file);
};

function render() {
    pdfDoc.getPage(pageNum).then(page => {
        scale = calculateScale(page); // Dynamically set scale
        viewport = page.getViewport({ scale });
        canvas.height = viewport.height; canvas.width = viewport.width;
        page.render({ canvasContext: ctx, viewport }).promise.then(showPageBoxes);
        document.getElementById('pageInfo').innerText = `Page ${pageNum} / ${pdfDoc.numPages}`;
        hideToolbar();
    });
}

// Re-render when window is resized
let resizeTimeout;
window.addEventListener('resize', () => {
    if (!pdfDoc) return;
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
        render();
    }, 200); // Debounce to prevent lag
});

document.getElementById('prevBtn').onclick = () => { if (pageNum > 1) { pageNum--; render(); } };
document.getElementById('nextBtn').onclick = () => { if (pageNum < pdfDoc.numPages) { pageNum++; render(); } };

// DRAWING OPERATIONS
cont.onmousedown = e => {
    if (e.target !== canvas && e.target !== cont) return;
    hideToolbar(); // Close toolbar when starting a new drawing
    isDrawing = true; const r = cont.getBoundingClientRect();
    startX = e.clientX - r.left; startY = e.clientY - r.top;
    sel.style.left = startX + 'px'; sel.style.top = startY + 'px';
    sel.style.width = '0'; sel.style.height = '0'; sel.style.display = 'block';
};

cont.onmousemove = e => {
    if (!isDrawing) return; const r = cont.getBoundingClientRect();
    const curX = e.clientX - r.left, curY = e.clientY - r.top;
    sel.style.width = Math.abs(curX - startX) + 'px'; sel.style.height = Math.abs(curY - startY) + 'px';
    sel.style.left = Math.min(startX, curX) + 'px'; sel.style.top = Math.min(startY, curY) + 'px';
};

cont.onmouseup = async e => {
    if (!isDrawing) return; isDrawing = false;
    const r = cont.getBoundingClientRect();
    const fX = Math.min(startX, e.clientX - r.left), fY = Math.min(startY, e.clientY - r.top);
    const fW = Math.abs((e.clientX - r.left) - startX), fH = Math.abs((e.clientY - r.top) - startY);
    sel.style.display = 'none';
    if (fW < 15 || fH < 15) return;

    // Prompt user for custom instructions immediately after drawing the box
    let customInst = prompt("Custom AI Instruction (e.g. 'Keep it under 10 words'. Leave blank for default):", "");
    if (customInst === null) return; // User cancelled the box creation entirely

    const box = {
        id: Date.now(), x: fX / scale, y: fY / scale, w: fW / scale, h: fH / scale,
        page: pageNum, canvasX: fX, canvasY: fY, canvasW: fW, canvasH: fH,
        answer: "AI is thinking...", customPrompt: customInst
    };
    boxes.push(box);
    showPageBoxes();
    await fetchSolution(box);
    document.getElementById('finish').classList.remove('hidden');
};

// -------------------------------------------------------------
// CALLIGRAPHER VIRTUAL ENGINE (PHASE 7 INTEGRATION)
// -------------------------------------------------------------
async function fetchSolution(boxObj) {
    const fd = new FormData();
    fd.append("file", document.getElementById('pdfIn').files[0]);
    fd.append("box", JSON.stringify(boxObj));

    try {
        const res = await fetch('/solve/', { method: 'POST', body: fd });
        const data = await res.json();
        const rawAns = data.answer;
        
        // 1. Visually update UI so user knows Groq finished
        boxObj.answer = "Synthesizing handwriting..."; 
        showPageBoxes();

        // 2. Trigger Neural Network locally in the browser
        const style = parseInt(document.getElementById('myInputStyle').value) || 4;
        const bias = parseFloat(document.getElementById('myInputBias').value) || 0.75;
        
        // Generate the SVG, then convert it to a transparent Base64 PNG.
        const base64Png = await generateFlawlessHandwriting(rawAns, boxObj.canvasW, boxObj.canvasH, style, bias);
        
        // 3. Save Final State
        boxObj.answer = rawAns;
        boxObj.pngBase64 = base64Png; // Python will use this later!
        
    } catch (err) { 
        console.error("Groq/Net Error:", err);
        boxObj.answer = "An error occurred!"; 
    }
    showPageBoxes();
}

async function generateFlawlessHandwriting(text, tWidth, tHeight, styleNum, stokeBias) {
    const sandbox = document.getElementById('svg-sandbox');
    sandbox.innerHTML = ''; // Fresh workspace

    // 1. Initialize Neural Net Calligrapher API
    if (typeof window.initCalligrapher !== 'function') {
        alert("🚨 KRİTİK HATA: El Yazısı Motoru Yüklenemedi! Lütfen tarayıcınızda CTRL + SHIFT + R (veya CMD + SHIFT + R) tuşlarına basarak önbelleği tamamen silip sayfayı yenileyiniz.");
        return null;
    }
    window.initCalligrapher(styleNum, stokeBias);

    // 2. Wrap text into lines based on Aspect Ratio
    let currentLines = [];
    const targetAR = tWidth / tHeight;
    let charsPerLine = 15;
    let projectedAR = 0;

    let words = text.split(' ');
    while (projectedAR < targetAR && charsPerLine < 65) {
        let testLines = [];
        let curL = "";
        for (let w of words) {
            if ((curL + w).length > charsPerLine && curL.length > 0) {
                testLines.push(curL.trim());
                curL = w + " ";
            } else {
                curL += w + " ";
            }
        }
        if (curL.trim()) testLines.push(curL.trim());
        let numLines = Math.max(testLines.length, 1);
        projectedAR = charsPerLine / (numLines * 1.5);
        if (projectedAR < targetAR) charsPerLine += 5; else { currentLines = testLines; break; }
    }
    if (currentLines.length === 0) currentLines = [text];

    // 3. Create SVG Container
    const svgNS = 'http://www.w3.org/2000/svg';
    const finalSvg = document.createElementNS(svgNS, 'svg');
    const group = document.createElementNS(svgNS, 'g');
    
    let currentY = 0;
    const rowHeight = 120; // Internal SVG coordinate drop

    for (let line of currentLines) {
        const textChunk = line + " ";
        // Call asynchronous Neural Net Engine dispatcher
        const pathD = await new Promise(resolve => {
            const listener = () => { window.removeEventListener('calligrapher_done', listener); resolve(window.get_svg_path()); };
            window.addEventListener('calligrapher_done', listener);
            window.generate_text(textChunk);
        });

        if (!pathD) continue;

        // Neural Net Internal Validation Dictionary (Phase 7 Match)
        const H = {"":0," ":2," ":8,'"':4,"&":84,"(":66,"*":80,",":37,".":7,0:62,2:63,4:68,6:71,8:76,":":74,B:47,D:52,F:53,H:41,J:64,L:48,N:38,P:46,R:55,T:31,V:39,X:79,Z:78,b:32,d:27,f:35,h:30,j:43,l:26,n:15,p:29,r:6,t:21,v:34,x:44,z:10," ":1," ":3,"!":72,"#":56,"'":16,")":67,"+":82,"-":40,"/":77,1:59,3:69,5:61,7:70,9:60,";":73,"?":51,A:9,C:57,E:42,G:45,I:23,K:58,M:5,O:36,Q:75,S:18,U:65,W:54,Y:50,"[":81,"]":83,a:14,c:20,e:19,g:33,i:13,k:28,m:12,o:25,q:49,s:17,u:11,w:24,y:22};
        let validChars = 0;
        for(let char of textChunk.split('')) { if (char in H) validChars++; }

        const engine_n = validChars + 2; 
        const engine_v = Math.min(105 / engine_n, 11);
        const scale_factor = 2.5 / engine_v;
        const engine_f = Math.max((1240 - 8.2 * engine_n * engine_v) / 2, 10);

        const finalPath = document.createElementNS(svgNS, 'path');
        finalPath.setAttribute('d', pathD);
        
        const translateX = 20 - (engine_f * scale_factor);
        const translateY = currentY - (270 * scale_factor);
        
        finalPath.setAttribute('transform', `translate(${translateX}, ${translateY}) scale(${scale_factor})`);
        finalPath.style.fill = "none";
        finalPath.style.stroke = "#111b4d"; // Dark Blue Pen Ink
        finalPath.style.strokeWidth = `${2.0 / scale_factor}px`;

        group.appendChild(finalPath);
        currentY += rowHeight;
    }

    finalSvg.appendChild(group);
    sandbox.appendChild(finalSvg);

    // 4. Edge-to-Edge Dimension Math (Zero Centering Bug!)
    const bbox = group.getBBox();
    const bx = bbox.x, by = bbox.y, bw = bbox.width, bh = bbox.height;
    
    // Strict SVG Viewport Crop
    finalSvg.setAttribute('viewBox', `${bx - 5} ${by - 5} ${bw + 10} ${bh + 10}`);
    finalSvg.setAttribute('preserveAspectRatio', 'xMinYMin meet');
    
    // Set absolute physical SVG dimensions to match the DOM target box
    finalSvg.setAttribute('width', tWidth + 'px');
    finalSvg.setAttribute('height', tHeight + 'px');

    // 5. Convert SVG to high-res PNG
    return new Promise((resolve) => {
        const svgData = new XMLSerializer().serializeToString(finalSvg);
        const img = new Image();
        img.onload = () => {
            const tempCanvas = document.createElement('canvas');
            // We increase resolution artificially by scaling for high DPI PDF prints
            const dpiScale = 2; 
            tempCanvas.width = tWidth * dpiScale;
            tempCanvas.height = tHeight * dpiScale;
            const tCtx = tempCanvas.getContext('2d');
            tCtx.scale(dpiScale, dpiScale);
            tCtx.drawImage(img, 0, 0, tWidth, tHeight);
            resolve(tempCanvas.toDataURL('image/png'));
        };
        img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
    });
}

// RENDERING BOXES ON SCREEN AND CLICK EVENTS
function showPageBoxes() {
    const layer = document.getElementById('preview-layer');
    layer.innerHTML = "";
    boxes.filter(b => b.page === pageNum).forEach(b => {
        // Recalculate canvas positions based on current scale
        b.canvasX = b.x * scale;
        b.canvasY = b.y * scale;
        b.canvasW = b.w * scale;
        b.canvasH = b.h * scale;

        const div = document.createElement('div');
        div.className = `preview-box ${b.id === activeBoxId ? 'active' : ''}`;
        div.style.left = b.canvasX + 'px'; div.style.top = b.canvasY + 'px';
        div.style.width = b.canvasW + 'px'; div.style.height = b.canvasH + 'px';
        div.style.fontSize = Math.max(12, (13 * scale * 0.8)) + 'px';
        
        // Show Handwriting Image if available, otherwise show the text (e.g. "AI is thinking...")
        if (b.pngBase64) {
            div.style.background = "transparent";
            div.style.border = b.id === activeBoxId ? "2px dashed #4f46e5" : "none";
            // The 'title' attribute gives us the perfect native tooltip the user asked for!
            div.title = b.answer; 
            div.innerHTML = `<img src="${b.pngBase64}" style="width:100%; height:100%; object-fit:contain; cursor:help;" draggable="false" />`;
            div.contentEditable = false;
        } else {
            div.innerText = b.answer;
            div.contentEditable = true;
            div.onblur = e => { b.answer = e.target.innerText; };
        }

        // Open toolbar when a box is clicked
        div.onclick = (e) => {
            e.stopPropagation(); // Prevent clicking on canvas
            activeBoxId = b.id;
            showPageBoxes(); // Re-render to update the active class
            showToolbar(b);
        };

        layer.appendChild(div);
    });

    if (boxes.length === 0) document.getElementById('finish').classList.add('hidden');
}

// TOOLBAR CONTROLS
function showToolbar(box) {
    document.getElementById('customPrompt').value = box.customPrompt || '';
    toolbar.style.display = 'flex';
}
function hideToolbar() {
    activeBoxId = null; toolbar.style.display = 'none'; showPageBoxes();
}

document.getElementById('closeToolbarBtn').onclick = hideToolbar;

document.getElementById('deleteBoxBtn').onclick = () => {
    boxes = boxes.filter(b => b.id !== activeBoxId);
    hideToolbar();
};

document.getElementById('reSolveBtn').onclick = async () => {
    let box = boxes.find(b => b.id === activeBoxId);
    if (!box) return;
    box.customPrompt = document.getElementById('customPrompt').value;
    box.answer = "Solving again...";
    showPageBoxes();
    await fetchSolution(box);
};

// FINALIZE
document.getElementById('finish').onclick = async () => {
    document.getElementById('finish').innerText = "Preparing...";
    const fd = new FormData();
    fd.append("file", document.getElementById('pdfIn').files[0]);
    
    // We pass the entire 'boxes' array. Each box now contains its own 
    // '.pngBase64' image string generated natively by the Calligrapher Engine in the browser!
    fd.append("results", JSON.stringify(boxes));

    const res = await fetch('/finalize/', { method: 'POST', body: fd });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = window.URL.createObjectURL(blob);
    a.download = "homework_ready.pdf"; a.click();
    document.getElementById('finish').innerText = "Print All to PDF";
};

// APP INITIALIZATION COMPLETE
