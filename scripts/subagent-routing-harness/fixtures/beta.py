def bucket(rows, size):
    """Split rows into consecutive chunks of `size`, dropping any short tail."""
    n = (len(rows) // size) * size
    return [rows[i:i + size] for i in range(0, n, size)]
