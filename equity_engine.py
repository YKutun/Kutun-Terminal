import yfinance as yf
import json
import time

def fetch_equity_data():
    target_tickers = [
        'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'BRK-B', 'LLY', 'AVGO', 'V', 
        'JPM', 'TSLA', 'WMT', 'UNH', 'MA', 'PG', 'JNJ', 'HD', 'MRK', 'ORCL', 
        'CVX', 'COST', 'ABBV', 'BAC', 'PEP', 'KO', 'NFLX', 'CRM', 'AMD', 'LIN', 
        'TMO', 'MCD', 'DIS', 'CSCO', 'INTC', 'ABT', 'WFC', 'QCOM', 'IBM', 'CAT', 
        'VZ', 'AMAT', 'UBER', 'PFE', 'GS', 'TXN', 'NOW', 'GE', 'ISRG', 'MS',
        'RY.TO', 'SHOP.TO', 'TD.TO', 'CNR.TO', 'CP.TO', 'ENB.TO', 'BAM.TO', 
        'ATD.TO', 'BMO.TO', 'CSU.TO', 'DOL.TO'
    ]
    
    equity_data = {}
    
    for ticker_symbol in target_tickers:
        print(f"Fetching data for {ticker_symbol}...")
        try:
            ticker = yf.Ticker(ticker_symbol)
            
            # Fetch Metadata
            info = ticker.info
            
            # Helper to safely get the value or return 'N/A'
            def get_stat(key):
                return info.get(key, 'N/A')
            
            # Process longBusinessSummary (Truncate to ~2 sentences)
            summary = get_stat('longBusinessSummary')
            if summary != 'N/A':
                sentences = summary.split('. ')
                summary = '. '.join(sentences[:2]) + ('.' if len(sentences) > 0 and not sentences[:2][-1].endswith('.') else '')
            
            current_price = get_stat('currentPrice')
            if current_price == 'N/A' and get_stat('regularMarketPrice') != 'N/A':
                current_price = get_stat('regularMarketPrice')
                
            metadata = {
                "longName": get_stat('longName'),
                "sector": get_stat('sector'),
                "longBusinessSummary": summary,
                "currentPrice": current_price,
                "marketCap": get_stat('marketCap'),
                "trailingPE": get_stat('trailingPE'),
                "fiftyTwoWeekHigh": get_stat('fiftyTwoWeekHigh'),
                "fiftyTwoWeekLow": get_stat('fiftyTwoWeekLow')
            }
            
            # Fetch 1-Year Historical Daily Closing Prices
            history = ticker.history(period="1y")
            
            historical_data = {}
            if not history.empty:
                for date, row in history.iterrows():
                    date_str = date.strftime('%Y-%m-%d')
                    close_price = round(row['Close'], 2)
                    historical_data[date_str] = close_price
            else:
                 historical_data = 'N/A'
                 
            # Combine into ticker dictionary
            equity_data[ticker_symbol] = {
                "metadata": metadata,
                "historical_prices": historical_data
            }
            
        except Exception as e:
            print(f"Error fetching data for {ticker_symbol}: {e}")
            equity_data[ticker_symbol] = "Error fetching data"
            
        # Time delay to prevent rate limiting
        time.sleep(0.5)

    print("Saving data to equity_data.json...")
    with open('equity_data.json', 'w') as f:
        json.dump(equity_data, f, indent=4)
    print("Done!")

if __name__ == "__main__":
    fetch_equity_data()
