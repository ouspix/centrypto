"""Offline policy adapter; uses frozen exits and never submits orders."""
from price_common import *
import price_network
from repair_policy import Policy

def load_policy(folder=None):
    return Policy(folder or CACHE/'bundle')
