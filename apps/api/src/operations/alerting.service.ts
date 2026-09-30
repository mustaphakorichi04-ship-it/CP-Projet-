import { Injectable, Logger } from '@nestjs/common';

type AlertLevel = 'INFO' | 'WARNING' | 'CRITICAL';

export interface AlertPayload {
  title: string;
  message: string;
  level: AlertLevel;
  metadata?: Record<string, any>;
}

@Injectable()
export class AlertingService {
  private readonly logger = new Logger(AlertingService.name);
  private readonly slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

  /**
   * Envoie une alerte aux équipes Ops / Business
   * (Combine console logger, Slack, et potentiel envoi email de secours)
   */
  async sendAlert(payload: AlertPayload) {
    const formattedMessage = `[${payload.level}] ${payload.title} - ${payload.message}`;
    
    // 1. Logs (Capturés par Datadog / Sentry)
    if (payload.level === 'CRITICAL') {
      this.logger.error(formattedMessage, JSON.stringify(payload.metadata));
    } else if (payload.level === 'WARNING') {
      this.logger.warn(formattedMessage, JSON.stringify(payload.metadata));
    } else {
      this.logger.log(formattedMessage);
    }

    // 2. Notification Slack (Équipe Business / Support)
    if (this.slackWebhookUrl) {
      await this.notifySlack(payload);
    } else {
      // Fallback local pour développement
      this.logger.debug(`[MOCK SLACK] Alert sent to #ops-alerts: ${payload.title}`);
    }
  }

  private async notifySlack(payload: AlertPayload) {
    const colorMap = {
      INFO: '#36a64f',      // Vert
      WARNING: '#ffcc00',   // Jaune
      CRITICAL: '#ff0000',  // Rouge
    };

    try {
      await fetch(this.slackWebhookUrl!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attachments: [
            {
              color: colorMap[payload.level],
              title: payload.title,
              text: payload.message,
              fields: payload.metadata 
                ? Object.entries(payload.metadata).map(([key, val]) => ({ title: key, value: String(val), short: true }))
                : [],
              ts: Math.floor(Date.now() / 1000)
            }
          ]
        })
      });
    } catch (err) {
      this.logger.error('Échec de la notification Slack', err);
    }
  }
}
