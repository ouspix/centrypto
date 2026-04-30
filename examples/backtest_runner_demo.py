"""
Demo-only Python SMA backtester.

This is not the real Centrypto backtester. The production backtest stack lives
under src/backtest and is run with npm run backtest:run.
"""

import pandas as pd
import numpy as np
import json
from datetime import datetime

class BacktestEngine:
    def __init__(self, initial_capital=10000):
        self.capital = initial_capital
        self.positions = []
        self.trades = []
        self.equity_curve = [initial_capital]

    def load_data(self, filepath):
        # Mock loading data from CSV
        # In reality: df = pd.read_csv(filepath)
        print(f"Loading data from {filepath}...")
        
        # Generate mock data
        dates = pd.date_range(start="2024-01-01", periods=100, freq="H")
        prices = 40000 + np.random.randn(100).cumsum() * 100
        
        self.data = pd.DataFrame({
            'timestamp': dates,
            'close': prices
        })
        print(f"Loaded {len(self.data)} candles.")

    def run_strategy(self):
        print("Running strategy...")
        # Simple Moving Average Crossover Strategy
        self.data['SMA_20'] = self.data['close'].rolling(window=20).mean()
        
        position = 0 # 0: Flat, 1: Long, -1: Short
        entry_price = 0
        
        for i in range(20, len(self.data)):
            row = self.data.iloc[i]
            prev_row = self.data.iloc[i-1]
            
            price = row['close']
            sma = row['SMA_20']
            
            # Signal Logic
            if price > sma and position <= 0:
                # Buy Signal
                if position == -1:
                    self._close_position(price, row['timestamp'], "Short")
                self._open_position(price, row['timestamp'], "Long")
                position = 1
                
            elif price < sma and position >= 0:
                # Sell Signal
                if position == 1:
                    self._close_position(price, row['timestamp'], "Long")
                self._open_position(price, row['timestamp'], "Short")
                position = -1
                
            # Update Equity (Mark to Market)
            # Simplified for demo
            
    def _open_position(self, price, timestamp, side):
        self.positions.append({
            'entry_price': price,
            'timestamp': timestamp,
            'side': side,
            'size': 1.0 # Fixed size
        })
        print(f"[{timestamp}] OPEN {side} @ {price:.2f}")

    def _close_position(self, price, timestamp, side):
        if not self.positions: return
        
        pos = self.positions.pop()
        pnl = (price - pos['entry_price']) * pos['size'] if side == "Long" else (pos['entry_price'] - price) * pos['size']
        
        self.capital += pnl
        self.equity_curve.append(self.capital)
        self.trades.append({
            'entry_time': pos['timestamp'],
            'exit_time': timestamp,
            'side': side,
            'pnl': pnl
        })
        print(f"[{timestamp}] CLOSE {side} @ {price:.2f} | PnL: {pnl:.2f}")

    def generate_report(self):
        total_trades = len(self.trades)
        if total_trades == 0:
            print("No trades executed.")
            return
            
        winning_trades = [t for t in self.trades if t['pnl'] > 0]
        win_rate = len(winning_trades) / total_trades * 100
        total_pnl = self.capital - 10000
        
        report = {
            "Initial Capital": 10000,
            "Final Capital": self.capital,
            "Total PnL": total_pnl,
            "Total Trades": total_trades,
            "Win Rate": f"{win_rate:.2f}%"
        }
        
        print("\n=== Backtest Report ===")
        print(json.dumps(report, indent=2))
        
        # Save to JSON
        with open("backtest_results.json", "w") as f:
            json.dump(report, f)

if __name__ == "__main__":
    engine = BacktestEngine()
    engine.load_data("hyperliquid_btc_1h.csv")
    engine.run_strategy()
    engine.generate_report()
