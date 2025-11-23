import { NextRequest, NextResponse } from 'next/server';
import { PriceAlertsService } from '@/services/PriceAlertsService';

const alertsService = new PriceAlertsService();

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const userAddress = searchParams.get('userAddress');
        const activeOnly = searchParams.get('activeOnly') === 'true';

        if (!userAddress) {
            return NextResponse.json(
                { error: 'userAddress parameter is required' },
                { status: 400 }
            );
        }

        const alerts = await alertsService.getAlerts(userAddress, activeOnly);

        return NextResponse.json({ alerts });
    } catch (error) {
        console.error('[API] Error fetching alerts:', error);
        return NextResponse.json(
            { error: 'Failed to fetch alerts' },
            { status: 500 }
        );
    }
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { symbol, condition, targetPrice, percentChange, userAddress } = body;

        if (!symbol || !condition || !targetPrice || !userAddress) {
            return NextResponse.json(
                { error: 'Missing required fields' },
                { status: 400 }
            );
        }

        const alert = await alertsService.createAlert({
            symbol,
            condition,
            targetPrice,
            percentChange,
            userAddress
        });

        return NextResponse.json({ alert }, { status: 201 });
    } catch (error) {
        console.error('[API] Error creating alert:', error);
        return NextResponse.json(
            { error: 'Failed to create alert' },
            { status: 500 }
        );
    }
}

export async function DELETE(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const alertId = searchParams.get('alertId');
        const userAddress = searchParams.get('userAddress');

        if (!alertId || !userAddress) {
            return NextResponse.json(
                { error: 'alertId and userAddress parameters are required' },
                { status: 400 }
            );
        }

        const success = await alertsService.deleteAlert(alertId, userAddress);

        if (!success) {
            return NextResponse.json(
                { error: 'Failed to delete alert or alert not found' },
                { status: 404 }
            );
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('[API] Error deleting alert:', error);
        return NextResponse.json(
            { error: 'Failed to delete alert' },
            { status: 500 }
        );
    }
}

export async function PATCH(request: NextRequest) {
    try {
        const body = await request.json();
        const { alertId, userAddress, action } = body;

        if (!alertId || !userAddress || !action) {
            return NextResponse.json(
                { error: 'Missing required fields' },
                { status: 400 }
            );
        }

        let alert = null;

        if (action === 'toggle') {
            alert = await alertsService.toggleAlert(alertId, userAddress);
        } else if (action === 'reset') {
            alert = await alertsService.resetAlert(alertId, userAddress);
        } else {
            return NextResponse.json(
                { error: 'Invalid action' },
                { status: 400 }
            );
        }

        if (!alert) {
            return NextResponse.json(
                { error: 'Alert not found or unauthorized' },
                { status: 404 }
            );
        }

        return NextResponse.json({ alert });
    } catch (error) {
        console.error('[API] Error updating alert:', error);
        return NextResponse.json(
            { error: 'Failed to update alert' },
            { status: 500 }
        );
    }
}
