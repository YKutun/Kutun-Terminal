import yfinance as yf
import pandas as pd
import json
from datetime import datetime
import os

def track_commodities():
    """
    Fetches historical futures data for a basket of commodities and exports 
    to a JSON format optimized for Chart.js.
    """
    
    # Define commodity map: { Display Name: Yahoo Ticker }
    commodity_map = {
        "Gold": "GC=F",
        "Silver": "SI=F",
        "Platinum": "PL=F",
        "Palladium": "PA=F",
        "Copper": "HG=F",
        "Soybeans": "ZS=F",
        "Brent Crude": "BZ=F",
        "WTI Crude": "CL=F",
        "Natural Gas": "NG=F",
        "Cocoa": "CC=F",
        "Lumber": "LBS=F",
        "Sugar": "SB=F",
        "Corn": "ZC=F",
        "Wheat": "ZW=F"
    }
    
    tickers = list(commodity_map.values())
    start_date = "2020-01-01"
    end_date = datetime.now().strftime('%Y-%m-%d')
    
    print(f"Fetching data for {len(tickers)} commodities from {start_date} to {end_date}...")
    
    # Download data
    data = yf.download(tickers, start=start_date, end=end_date)
    
    # High-level structure for JSON: { "CommodityName": { "labels": [], "prices": [] } }
    output_data = {}
    
    for name, ticker in commodity_map.items():
        try:
            # Check for Adj Close or Close in the MultiIndex
            if ('Adj Close', ticker) in data.columns:
                ticker_series = data['Adj Close'][ticker]
            elif ('Close', ticker) in data.columns:
                ticker_series = data['Close'][ticker]
            else:
                print(f"Warning: No data found for {name} ({ticker})")
                continue

            # Drop leading NaNs and ffill internal ones
            ticker_series = ticker_series.dropna(how='all').ffill()
            
            if ticker_series.empty:
                print(f"Warning: Data series for {name} is empty.")
                continue

            # Format: Dates as labels, Prices as values
            output_data[name] = {
                "labels": [d.strftime('%Y-%m-%d') for d in ticker_series.index],
                "prices": [round(float(p), 2) for p in ticker_series.values]
            }
            print(f"Processed: {name}")
            
        except Exception as e:
            print(f"Error processing {name} ({ticker}): {e}")

    # Save to JSON
    output_file = "commodities_data.json"
    with open(output_file, 'w') as f:
        json.dump(output_data, f, indent=2)
    
    print(f"\nSuccessfully saved {len(output_data)} commodities to {output_file}")
    print("\nHow high-level JSON structure works:")
    print("1. Root key is the human-readable 'Name' of the commodity.")
    print("2. 'labels' is an array of ISO-formatted date strings (X-axis).")
    print("3. 'prices' is an array of floats (Y-axis).")
    print("This structure allows Chart.js to map data instantly: myChart.data.labels = data['Gold'].labels")

if __name__ == "__main__":
    track_commodities()
