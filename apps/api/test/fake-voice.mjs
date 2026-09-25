// Inworld STT y DeepSeek falsos:  node test/fake-voice.mjs 59048
//   INWORLD_STT_URL=http://127.0.0.1:59048/stt/v1/transcribe  DEEPSEEK_URL=http://127.0.0.1:59048
// GET /sent: lo recibido. POST /fail: la próxima transcripción responde 500.
import http from 'node:http';
const sent = [];
let failNext = false;
http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/sent') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(sent));
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    if (req.url === '/fail') { failNext = true; return res.writeHead(204).end(); }
    const body = data ? JSON.parse(data) : {};
    if (req.url === '/stt/v1/transcribe') {
      sent.push({ kind: 'stt', auth: req.headers.authorization, config: body.transcribeConfig, bytes: Buffer.from(body.audioData?.content ?? '', 'base64').length });
      if (failNext) { failNext = false; return res.writeHead(500, { 'content-type': 'application/json' }).end('{"message":"falla simulada"}'); }
      const text = body.transcribeConfig?.language?.startsWith('en') ? 'hello team please send the contract tomorrow' : 'hola equipo por favor envíen el contrato firmado mañana temprano';
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ transcription: { transcript: text, wordTimestamps: [] }, usage: { transcribedAudioMs: 2000 } }));
    }
    if (req.url === '/chat/completions') {
      sent.push({ kind: 'llm', auth: req.headers.authorization, model: body.model, messages: body.messages });
      const content = JSON.stringify({ summary: 'Piden el contrato firmado para mañana', suggestedIssue: 'Enviar el contrato firmado' });
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    }
    res.writeHead(404).end();
  });
}).listen(Number(process.argv[2] ?? 59048), '127.0.0.1', () => console.log('fake-voice listo'));
