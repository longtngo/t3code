def total(rows):
    """Sum the 'amount' field of every row whose 'status' is 'settled'."""
    return sum(r["amount"] for r in rows if r.get("status") == "settled")
