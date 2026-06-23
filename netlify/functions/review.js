const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { prompt, systemPrompt, zipBase64, zipName } = body;

  // If ZIP file provided, extract and build code content
  let finalPrompt = prompt;
  if (zipBase64 && zipName) {
    try {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-review-'));
      const zipPath = path.join(tmpDir, 'submission.zip');
      fs.writeFileSync(zipPath, Buffer.from(zipBase64, 'base64'));

      const extractDir = path.join(tmpDir, 'extracted');
      fs.mkdirSync(extractDir);

      try {
        execSync(`unzip -q "${zipPath}" -d "${extractDir}"`, { timeout: 10000 });
      } catch (e) {
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Could not extract ZIP file. Please check the file is valid.' }) };
      }

      const codeExts = ['.js','.ts','.jsx','.tsx','.py','.java','.cs','.go','.rb','.php','.swift','.kt','.rs','.cpp','.c','.h','.vue','.html','.css','.scss','.md','.json','.yaml','.yml','.toml','.sh','.sql','.tf','.gradle','.xml','.dart','.scala'];
      const skipDirs = ['node_modules','__pycache__','.git','dist','build','.next','vendor','venv','.venv'];

      let codeContent = `ZIP file: ${zipName}\n\nFiles reviewed:\n`;
      let files = [];

      function walkDir(dir, base) {
        try {
          const items = fs.readdirSync(dir);
          for (const item of items) {
            const fullPath = path.join(dir, item);
            const relPath = path.join(base, item);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              if (!skipDirs.includes(item)) walkDir(fullPath, relPath);
            } else if (codeExts.some(ext => item.endsWith(ext))) {
              files.push({ fullPath, relPath });
            }
          }
        } catch(e) {}
      }

      walkDir(extractDir, '');
      files = files.slice(0, 30);
      codeContent += files.map(f => '  ' + f.relPath).join('\n') + '\n\n';

      let fetched = 0;
      for (const f of files) {
        if (fetched >= 20) break;
        try {
          const text = fs.readFileSync(f.fullPath, 'utf8');
          if (text.length < 10000) {
            codeContent += `\n${'─'.repeat(60)}\nFILE: ${f.relPath}\n${'─'.repeat(60)}\n${text}\n`;
            fetched++;
          }
        } catch(e) {}
      }

      // Clean up
      try { fs.rmSync(tmpDir, { recursive: true }); } catch(e) {}

      // Replace the prompt's placeholder with actual code
      finalPrompt = prompt.replace('ZIP_CONTENT_PLACEHOLDER', codeContent);
    } catch (err) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'ZIP processing error: ' + err.message }) };
    }
  }

  if (!finalPrompt) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing prompt' }) };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  try {
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: finalPrompt });

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: messages,
        temperature: 0.2,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { statusCode: response.status, headers: cors, body: JSON.stringify({ error: 'Groq error: ' + errText }) };
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) };

  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
