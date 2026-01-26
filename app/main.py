from fastapi import FastAPI

from api.endpoints.alliances import AllianceAPI
from api.endpoints.matches import MatchAPI

app = FastAPI()

@app.get("/")
async def root():
    return {"message": "Welcome to Caster's Tool API"}

@app.get("/alliances/{team_key}")
async def get_team_alliances(team_key: str):
    api = AllianceAPI(api_key="your_api_key_here")
    response = api.get_alliances(team_key=team_key)
    return response

@app.get("/alliances/event/{event_key}")
async def get_event_alliances(event_key: str):
    api = AllianceAPI(api_key="your_api_key_here")
    response = api.get_alliance_data(event_key=event_key)
    return response

@app.get("/matches/{match_key}")
async def get_match_data(match_key: str):
    api = MatchAPI(match_key)
    response = api.get_match_data()
    return response

@app.get("/matches/{match_key}/score")
async def get_match_score(match_key: str):
    api = MatchAPI(match_key)
    response = api.get_score_breakdown()
    return response
