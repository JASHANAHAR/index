curl -X POST "wss://2bd497425eb2.ngrok-free.app/api/media?uuid=2452bef5-0456-4510-a891-15ce2a872484&region=https%3A%2F%2Fapi-us-3.vonage.com" \
  -H "Content-Type: application/json" \
  -d '{
    "uuid": "fe789e0b-a5c6-4fd3-b509-fab49b894301",
    "speech": { "results": [ { "text": "What are your clinic hours?", "confidence": 0.93 } ] }
  }'
