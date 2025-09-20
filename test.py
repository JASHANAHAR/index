# test.py
import asyncio, json, wave, websockets, time

WS_URL = "ws://127.0.0.1:8001/api/media?uuid=test123&region=https%3A%2F%2Fapi-us-3.vonage.com"

async def fake_vonage():
    async with websockets.connect(WS_URL) as ws:
        print("[Fake] connected")

        # initial json
        await ws.send(json.dumps({
            "event": "websocket:connected",
            "content-type": "audio/l16;rate=8000"
        }))

        # optional start (your server will also work without it)
        await ws.send(json.dumps({"event": "start", "start": {"sample_rate": 8000}}))

        # stream 8kHz mono 16-bit PCM WAV
        with wave.open("sample_8k_mono16.wav", "rb") as wf:
            assert wf.getframerate() == 8000
            assert wf.getnchannels() == 1
            assert wf.getsampwidth() == 2

            while True:
                data = wf.readframes(160)  # 20ms @ 8kHz
                if not data:
                    break
                await ws.send(data)
                await asyncio.sleep(0.02)

        await ws.send(json.dumps({"event": "stop"}))
        await asyncio.sleep(0.5)

if __name__ == "__main__":
    asyncio.run(fake_vonage())
