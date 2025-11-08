# Environment Configuration

Create a `.env` file in the root directory with the following variables:

```env
NUM_WORKERS=8
MAX_CONCURRENT_REQUESTS=10000
QUEUE_MAX_SIZE=50000
PORT=3000
```

## Configuration Options

- `NUM_WORKERS`: Number of worker processes (defaults to CPU count)
- `MAX_CONCURRENT_REQUESTS`: Total concurrent requests across all workers (default: 10,000)
- `QUEUE_MAX_SIZE`: Maximum queue size (default: 50,000)
- `PORT`: Server port (default: 3000)

## Usage

1. Create a `.env` file with your desired configuration
2. Run `npm install` to install dependencies (including dotenv)
3. Run `npm start` to start the server

The application will automatically load environment variables from the `.env` file.

