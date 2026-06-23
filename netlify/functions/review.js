const zlib = require('zlib');
const { Buffer } = require('buffer');

// Simple ZIP parser - reads local file headers
function parseZip(buffer) {
  const files = [];
  let offset = 0;
  
  while (offset < buffer.length - 4) {
    // Local file header signature
    if (buffer.readUInt32LE(offset) !== 0x04034b50) {
      offset++;
      continue;
    }
    
    try {
      const compression = buffer.readUInt16LE(offset + 8);
      const compressedSize = buffer.readUInt32LE(offset + 18);
      const uncompressedSize = buffer.readUInt32LE(offset + 22);
      const fileNameLength = buffer.readUInt16LE(offset + 26);
      const extraLength = buffer.readUInt16LE(offset + 28);
      
      const fileName = buffer.slice(offset + 30, offset + 30 + fileNameLength).toString('utf8');
      const dataOffset = offset + 30 + fileNameLength + extraLength;
      
      if (!fileName.endsWith('/') && compressedSize > 0 && compressedSize < 500000) {
        const compressedData = buffer.slice(dataOffset, dataOffset + compressedSize);
        
        let content = null;
        try {
          if (compression === 0) {
            content = compressedData.toString('utf8');
          } else if (compression === 8) {
            content = zlib.inflateRawSync(compressedData).toString('utf8');
          }
        } catch(e) {}
        
        if (content) files.push({ name: fileName, content });
      }
      
      offset = dataOffset + compressedSize;
    } catch(e) {
      offset++;
    }
  }
  
  return files;
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { prompt, systemPrompt, zipBase64, zipName } = body;

  let finalPrompt = prompt;

  if (zipBase64 && zipName) {
    try {
      const codeExts = ['.js','.ts','.jsx','.tsx','.py','.java','.cs','.go','.rb','.php','.swift','.kt','.rs','.cpp','.c','.h','.vue','.html','.css','.scss','.md','.json','.yaml','.yml','.toml','.sh','.sql','.tf','.gradle','.xml','.dart','.scala'];
      const skipDirs = ['node_modules','__pycache__','.git','dist','build','.next','vendor','venv','.venv'];

      const zipBuffer = Buffer.from(zipBase64, 'base64');
      const allFiles = parseZip(zipBuffer);

      const codeFiles = allFiles
        .filter(f => {
          const skip = skipDirs.some(d => f.name.includes('/' + d + '/') || f.name.startsWith(d + '/'));
          const isCode = codeExts.some(ext => f.name.endsWith(ext));
          return isCode && !skip;
        })
        .slice(0, 25);

      let codeContent = `ZIP file: ${zipName}\n\nFiles reviewed (${codeFiles.length}):\n`;
      codeContent += codeFiles.map(f => '  ' + f.name).join('\n') + '\n\n';

      for (const f of codeFiles.slice(0, 20)) {
        if (f.content && f.content.length < 10000) {
          codeContent += `\n${'─'.repeat(60)}\nFILE: ${f.name}\n${'─'.repeat(60)}\n${f.content}\n`;
        }
      }

      finalPrompt = prompt.replace('ZIP_CONTENT_PLACEHOLDER', codeContent);
    } catch (err) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'ZIP processing error: ' + err.message }) };
    }
  }

  if (!finalPrompt) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing prompt' }) };

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'API key not configured' }) };

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
        messages,
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
