import { prisma } from "@/lib/db";
import crypto from 'crypto';

export type AlertCondition = 'above' | 'below' | 'percent_change_up' | 'percent_change_down';

export type PriceAlert = {
    id: string;
    symbol: string;
    condition: AlertCondition;
    targetPrice: number;
    percentChange?: number;
    isActive: boolean;
    triggered: boolean;
    createdAt: Date;
    triggeredAt?: Date;
    userAddress: string;
};

export type CreateAlertParams = {
    symbol: string;
    condition: AlertCondition;
    targetPrice: number;
    percentChange?: number;
    userAddress: string;
};

export class PriceAlertsService {
    /**
     * Create a new price alert
     */
    async createAlert(params: CreateAlertParams): Promise<PriceAlert> {
        const alert = await prisma.priceAlert.create({
            data: {
                id: crypto.randomUUID(),
                symbol: params.symbol,
                condition: params.condition,
                targetPrice: params.targetPrice,
                percentChange: params.percentChange,
                userAddress: params.userAddress,
                isActive: true,
                triggered: false
            }
        });

        return this.mapToAlert(alert);
    }

    /**
     * Get all alerts for a user
     */
    async getAlerts(userAddress: string, activeOnly: boolean = false): Promise<PriceAlert[]> {
        const alerts = await prisma.priceAlert.findMany({
            where: {
                userAddress,
                ...(activeOnly && { isActive: true, triggered: false })
            },
            orderBy: { createdAt: 'desc' }
        });

        return alerts.map(this.mapToAlert);
    }

    /**
     * Delete an alert
     */
    async deleteAlert(alertId: string, userAddress: string): Promise<boolean> {
        try {
            await prisma.priceAlert.delete({
                where: {
                    id: alertId,
                    userAddress // Ensure user owns the alert
                }
            });
            return true;
        } catch (err) {
            console.error('[PriceAlerts] Failed to delete alert:', err);
            return false;
        }
    }

    /**
     * Toggle alert active status
     */
    async toggleAlert(alertId: string, userAddress: string): Promise<PriceAlert | null> {
        try {
            const alert = await prisma.priceAlert.findUnique({
                where: { id: alertId }
            });

            if (!alert || alert.userAddress !== userAddress) {
                return null;
            }

            const updated = await prisma.priceAlert.update({
                where: { id: alertId },
                data: { isActive: !alert.isActive }
            });

            return this.mapToAlert(updated);
        } catch (err) {
            console.error('[PriceAlerts] Failed to toggle alert:', err);
            return null;
        }
    }

    /**
     * Check alerts against current prices and trigger if conditions are met
     */
    async checkAlerts(prices: Record<string, number>): Promise<PriceAlert[]> {
        const triggeredAlerts: PriceAlert[] = [];

        // Get all active, non-triggered alerts
        const activeAlerts = await prisma.priceAlert.findMany({
            where: {
                isActive: true,
                triggered: false
            }
        });

        for (const alert of activeAlerts) {
            const currentPrice = prices[alert.symbol];
            if (!currentPrice) continue;

            let shouldTrigger = false;

            switch (alert.condition) {
                case 'above':
                    shouldTrigger = currentPrice >= alert.targetPrice;
                    break;
                case 'below':
                    shouldTrigger = currentPrice <= alert.targetPrice;
                    break;
                case 'percent_change_up':
                    if (alert.percentChange) {
                        const changePercent = ((currentPrice - alert.targetPrice) / alert.targetPrice) * 100;
                        shouldTrigger = changePercent >= alert.percentChange;
                    }
                    break;
                case 'percent_change_down':
                    if (alert.percentChange) {
                        const changePercent = ((alert.targetPrice - currentPrice) / alert.targetPrice) * 100;
                        shouldTrigger = changePercent >= alert.percentChange;
                    }
                    break;
            }

            if (shouldTrigger) {
                const updated = await prisma.priceAlert.update({
                    where: { id: alert.id },
                    data: {
                        triggered: true,
                        triggeredAt: new Date()
                    }
                });

                triggeredAlerts.push(this.mapToAlert(updated));
            }
        }

        return triggeredAlerts;
    }

    /**
     * Reset a triggered alert (for reuse)
     */
    async resetAlert(alertId: string, userAddress: string): Promise<PriceAlert | null> {
        try {
            const alert = await prisma.priceAlert.findUnique({
                where: { id: alertId }
            });

            if (!alert || alert.userAddress !== userAddress) {
                return null;
            }

            const updated = await prisma.priceAlert.update({
                where: { id: alertId },
                data: {
                    triggered: false,
                    triggeredAt: null,
                    isActive: true
                }
            });

            return this.mapToAlert(updated);
        } catch (err) {
            console.error('[PriceAlerts] Failed to reset alert:', err);
            return null;
        }
    }

    /**
     * Get alerts for a specific symbol
     */
    async getAlertsForSymbol(symbol: string, userAddress: string): Promise<PriceAlert[]> {
        const alerts = await prisma.priceAlert.findMany({
            where: {
                symbol,
                userAddress,
                isActive: true,
                triggered: false
            },
            orderBy: { createdAt: 'desc' }
        });

        return alerts.map(this.mapToAlert);
    }

    private mapToAlert(dbAlert: any): PriceAlert {
        return {
            id: dbAlert.id,
            symbol: dbAlert.symbol,
            condition: dbAlert.condition as AlertCondition,
            targetPrice: dbAlert.targetPrice,
            percentChange: dbAlert.percentChange,
            isActive: dbAlert.isActive,
            triggered: dbAlert.triggered,
            createdAt: dbAlert.createdAt,
            triggeredAt: dbAlert.triggeredAt,
            userAddress: dbAlert.userAddress
        };
    }
}
