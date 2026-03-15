import yfinance as yf
import pandas as pd
from datetime import datetime, timedelta
import os

class FinanceDataCollector:
    def __init__(self):
        self.base_path = os.getcwd()

    def download_historical_prices(self, tickers, years=5, filename="financial_data.csv"):
        """Downloads historical adjusted close prices for a list of tickers."""
        end_date = datetime.now()
        start_date = end_date - timedelta(days=years*365)
        
        print(f"Downloading historical prices for {tickers} from {start_date.strftime('%Y-%m-%d')} to {end_date.strftime('%Y-%m-%d')}...")
        
        data = yf.download(tickers, start=start_date, end=end_date)
        
        # Handle the MultiIndex returned by yfinance for multiple tickers
        if isinstance(data.columns, pd.MultiIndex):
            if 'Adj Close' in data.columns.levels[0]:
                data = data['Adj Close']
            else:
                data = data['Close']
        else:
            # Single ticker case
            if 'Adj Close' in data.columns:
                data = data[['Adj Close']]
            else:
                data = data[['Close']]

        # Rename columns if needed (optional, keeping it simple for now)
        # For simplicity in this terminal, let's just save the raw adjusted closes
        
        data.to_csv(filename)
        print(f"Historical prices saved to {filename}")

    def download_fundamentals(self, ticker_symbol):
        """Downloads annual Income Statement and Balance Sheet for a given ticker."""
        print(f"Downloading fundamentals for {ticker_symbol}...")
        ticker = yf.Ticker(ticker_symbol)
        
        # Income Statement
        income_stmt = ticker.income_stmt
        income_stmt_file = f"{ticker_symbol.lower()}_income_stmt.csv"
        income_stmt.to_csv(income_stmt_file)
        print(f"Income Statement saved to {income_stmt_file}")
        
        # Balance Sheet
        balance_sheet = ticker.balance_sheet
        balance_sheet_file = f"{ticker_symbol.lower()}_balance_sheet.csv"
        balance_sheet.to_csv(balance_sheet_file)
        print(f"Balance Sheet saved to {balance_sheet_file}")

if __name__ == "__main__":
    collector = FinanceDataCollector()
    
    # 1. Download Historical Prices (S&P 500 and Apple)
    collector.download_historical_prices(["^GSPC", "AAPL"])
    
    # 2. Download Fundamentals for Apple
    collector.download_fundamentals("AAPL")
