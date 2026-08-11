import { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = req.query.id;
  if (!id || Array.isArray(id)) {
    res.status(400).json({ error: 'Provide a single "id" query parameter.' });
    return;
  }

  const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:7071';
  const upstream = await fetch(`${apiBaseUrl}/api/story?id=${encodeURIComponent(id)}`);
  const body = await upstream.text();
  res.status(upstream.status).setHeader('Content-Type', 'application/json').send(body);
}
