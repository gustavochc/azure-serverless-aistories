"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const functions_1 = require("@azure/functions");
const nodemailer = __importStar(require("nodemailer"));
const eventGridTrigger = async function (eventGridEvent, context) {
    const detail = eventGridEvent?.data;
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
functions_1.app.eventGrid('notifyStoryCreated', {
    handler: eventGridTrigger,
});
