# HVH SG Tracker

Tiny Node site that tracks these CS2 Singapore servers in near realtime:

- `139.99.62.233:27015`
- `103.216.223.85:7023`
- `139.99.62.233:27017`

## Run

```bash
cd hvh-sg-tracker
npm start
```

Then open `http://localhost:8787`.

## Notes

- The page refreshes every 10 seconds.
- Data comes from the public `https://hvh.wtf/api/servers` endpoint.
- "Realtime" here depends on how often that upstream list updates.
