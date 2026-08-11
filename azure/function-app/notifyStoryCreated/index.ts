import { app, EventGridEvent, InvocationContext } from '@azure/functions';
import * as nodemailer from 'nodemailer';

interface StoryCreatedEvent {
  id: string;
  title: string;
  description: string;
  scene: string;
}

const eventGridTrigger = async function (eventGridEvent: EventGridEvent, context: InvocationContext): Promise<void> {
  const detail = eventGridEvent?.data as unknown as StoryCreatedEvent;
  if (!detail?.id || !detail?.title) {
    context.log('Invalid event payload');
    return;
  }

  const to = process.env.NOTIFY_EMAIL_TO;
  if (!to) {
    context.log('NOTIFY_EMAIL_TO not set, skipping notification email');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const storyUrl = `${process.env.FRONTEND_BASE_URL || ''}/story?id=${detail.id}`;

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to,
    subject: `Nuevo cuento: ${detail.title}`,
    text: `Se ha creado un nuevo cuento para Vega: "${detail.title}"\n\nLéelo aquí: ${storyUrl}`,
    html: `<p>Se ha creado un nuevo cuento para Vega: <strong>${detail.title}</strong></p><p><a href="${storyUrl}">Léelo aquí</a></p>`,
  });

  context.log(`Notification email sent to ${to} for story ${detail.id}`);
};

app.eventGrid('notifyStoryCreated', {
  handler: eventGridTrigger,
});
