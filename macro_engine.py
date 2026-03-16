import yfinance as yf
import json
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime
import re

def fetch_sector_historical_data():
    """
    Fetches historical closing prices for the 11 major SPDR Sector ETFs.
    Formats data for Chart.js: {ticker: [{x: date, y: price}, ...]}
    """
    tickers = ["XLK", "XLF", "XLV", "XLE", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE", "XLC"]
    start_date = "2005-01-01"
    end_date = datetime.now().strftime("%Y-%m-%d")
    
    print(f"Fetching historical sector data from {start_date} to {end_date}...")
    
    all_data = {}
    try:
        data = yf.download(tickers, start=start_date, end=end_date, interval="1d")["Close"]
        data = data.ffill().bfill()
        
        for ticker in tickers:
            if ticker in data.columns:
                series = []
                ticker_data = data[ticker].dropna()
                for date, price in ticker_data.items():
                    series.append({
                        "x": date.strftime("%Y-%m-%d"),
                        "y": round(float(price), 2)
                    })
                all_data[ticker] = series
        
        with open("sector_historical.json", "w") as f:
            json.dump(all_data, f, indent=4)
        print("Successfully saved sector_historical.json")
    except Exception as e:
        print(f"Error fetching historical data: {e}")

def export_macro_events():
    events = [
        {"name": "2008 Lehman Brothers Collapse", "date": "2008-09-15", "description": "Lehman Brothers filed for bankruptcy, escalating the global financial crisis."},
        {"name": "COVID-19 Market Crash", "date": "2020-02-20", "description": "Global stock markets began a sharp drop due to the spread of COVID-19."},
        {"name": "Russia-Ukraine Invasion", "date": "2022-02-24", "description": "Russia launched an invasion of Ukraine, causing energy and commodity volatility."}
    ]
    try:
        with open("macro_events.json", "w") as f:
            json.dump(events, f, indent=4)
        print("Successfully saved macro_events.json")
    except Exception as e:
        print(f"Error exporting macro events: {e}")

def scrape_live_news():
    """
    Scrapes a reliable RSS feed and filters with a strict macro whitelist.
    """
    # Yahoo Finance RSS Index - Reliable source
    rss_url = "https://finance.yahoo.com/news/rssindex"
    print(f"Scraping macro news from {rss_url}...")
    
    exclude_keywords = ["surges", "plummets", "earnings", "dividend", "ipo", "shares", "buyback", "stock", "quarterly"]
    whitelist_keywords = [
        "fed", "inflation", "rates", "gdp", "treasury", "debt", "global", "ecb", 
        "powell", "war", "recession", "economy", "central bank", "yield", "bond",
        "spending", "trade", "deficit", "unemployment", "payrolls", "geopolitical"
    ]
    ticker_pattern = re.compile(r'\([A-Z]+\)')

    try:
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
        req = urllib.request.Request(rss_url, headers=headers)
        with urllib.request.urlopen(req) as response:
            xml_data = response.read()
            
        root = ET.fromstring(xml_data)
        news_items = []
        
        for item in root.findall(".//item"):
            title_node = item.find("title")
            link_node = item.find("link")
            pub_date_node = item.find("pubDate")
            
            if title_node is None or title_node.text is None:
                continue
            
            headline = title_node.text.strip()
            link = link_node.text.strip() if link_node is not None and link_node.text else ""
            pub_date = pub_date_node.text.strip() if pub_date_node is not None and pub_date_node.text else ""
            
            headline_lower = headline.lower()

            # Filter Logic
            # 1. Exclude if ticker in parentheses found
            if ticker_pattern.search(headline):
                continue
            
            # 2. Exclude if noise keywords found
            if any(kw in headline_lower for kw in exclude_keywords):
                continue
            
            # 3. Whitelist check (STRICT MACRO)
            if not any(wk in headline_lower for wk in whitelist_keywords):
                continue
                
            news_items.append({
                "headline": headline,
                "link": link,
                "published_at": pub_date
            })
            
            if len(news_items) >= 50:
                break
                
        with open("live_news.json", "w") as f:
            json.dump(news_items, f, indent=4)
        print(f"Successfully saved {len(news_items)} macro news items to live_news.json")
        
    except Exception as e:
        print(f"Error scraping live news: {e}")

def main():
    print("--- Kutun Terminal: Macro Engine Strict Filtering ---")
    export_macro_events()
    scrape_live_news()
    fetch_sector_historical_data()
    print("--- Macro Engine Tasks Completed ---")

if __name__ == "__main__":
    main()
